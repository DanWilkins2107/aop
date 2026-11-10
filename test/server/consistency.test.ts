import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { ChangeFeed } from "../../src/server/changes.js";
import { loadConfig } from "../../src/server/config.js";
import { openDb } from "../../src/server/db.js";
import { createNode, getNodeRow } from "../../src/server/nodes.js";
import { Orchestrator } from "../../src/server/orchestrator.js";
import { isAlive, waitGone } from "../../src/server/osProcesses.js";
import { addProject } from "../../src/server/projects.js";
import { beginRun } from "../../src/server/runs.js";
import type { NodeView } from "../../src/shared/api.js";
import { resultText } from "../mcp/helpers.js";
import { directives, fakeConfig, settle, toolCall, world, type World } from "./agents.helpers.js";
import { harness, makeHome, makeRepo, STAGES_YAML } from "./helpers.js";

const TIMEOUT = { timeout: 90_000 };

/** A tool call on the world's MCP server, as an agent makes it, with its result's text. */
async function toolAs(w: World, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const client = new Client({ name: "aop-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(w.mcpUrl)));
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { isError: result.isError === true, text: resultText(result) };
  } finally {
    await client.close();
  }
}

describe("an invalid stages.yaml", () => {
  // A refused request must change nothing: the change feed only fires on success, so a write that
  // commits and then fails to render its answer is one the orchestrator and the UI never hear about.
  it.each([
    ["invalidate", { reason: "Not needed" }],
    ["block", { reason: "Waiting on a vendor" }],
    ["claim", {}],
  ])("refuses %s before writing anything", async (action, body) => {
    const h = harness();
    const node = await h.create("dev");
    h.rewriteStages("stages: { broken: { turn: agent } }\ntypes: {}\n");
    const res = await h.post(node.id, action, body);
    expect(res.status).toBe(422);
    h.rewriteStages(STAGES_YAML);
    expect(await h.node(node.id)).toMatchObject({ stage: "write_spec", claimed_by: null });
  });

  it("refuses an edit before writing anything", async () => {
    const h = harness();
    const node = await h.create("dev");
    h.rewriteStages("stages: { broken: { turn: agent } }\ntypes: {}\n");
    expect((await h.call("PATCH", `/api/nodes/${node.id}`, { title: "Renamed" })).status).toBe(422);
    h.rewriteStages(STAGES_YAML);
    expect((await h.node(node.id)).title).toBe("A dev node");
  });
});

describe("agent identity", () => {
  it("refuses a stage change from a run that has ended, even on the same node", TIMEOUT, async () => {
    const w = await world();
    // Two agent stages in a row: the first run moves the node on and exits, and the second hangs.
    writeFileSync(
      join(w.home, "stages.yaml"),
      STAGES_YAML.replace(
        "implement:   { next: { fixed: done, to_nightly: nightly } }",
        "implement:   { next: { fixed: write_spec } }\n      write_spec:  { next: { again: done } }",
      ),
    );
    const node = await w.create(
      directives(`ifnot Stage: write_spec :: ${toolCall("next", { outcome: "fixed" })}`, "ifnot Stage: write_spec :: exit 0", "hang"),
    );
    const second = await w.runStarted(node.id, 2);
    const [first] = w.runs(node.id);
    expect(first).toMatchObject({ status: "exited", end_reason: "reported" });

    // What a process the first run left behind would send: it still has that run's ID.
    const stale = await toolAs(w, "ask", { node_id: node.id, run_id: first!.id, question: "Still here?" });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("has ended");
    expect(w.node(node.id).stage).toBe("write_spec");
    expect(w.runs(node.id)[1]).toMatchObject({ id: second.id, status: "running", left_via: null });

    // Its other writes are refused too, while the current run's go through.
    const message = await toolAs(w, "message", { node_id: node.id, run_id: first!.id, body: "stale" });
    expect(message.isError).toBe(true);
    expect(message.text).toContain("has ended");
    const current = await toolAs(w, "ask", { node_id: node.id, run_id: second.id, question: "Which way?" });
    expect(current).toMatchObject({ isError: false });
    expect(w.node(node.id).stage).toBe("ask_human_question");
  });

  it("refuses a run's stage change on a node that isn't the run's", TIMEOUT, async () => {
    const w = await world();
    const node = await w.create(directives("hang"));
    const run = await w.runStarted(node.id);
    // Held from the moment it exists, by an invalidated parent, so no run of its own starts on it.
    const parent = await w.create("", { type: "dev", stage: "pr_review" });
    await w.call("POST", `/nodes/${parent.id}/invalidate`, { reason: "Hold the child" });
    const other = await w.create("", { parent_id: parent.id });
    const res = await toolAs(w, "ask", { node_id: other.id, run_id: run.id, question: "Which way?" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`isn't the run on node ${other.id}`);
    expect((w.node(other.id) as NodeView).stage).toBe("implement");
    expect(w.runs(other.id)).toEqual([]);
  });
});

describe("claims", () => {
  it("a run starts only on an unclaimed node, and a refused start writes nothing", async () => {
    const h = harness();
    const runsOn = (id: string) => (h.db.prepare("SELECT count(*) AS n FROM runs WHERE node_id = ?").get(id) as { n: number }).n;

    const human = await h.create("dev");
    h.db.prepare("UPDATE nodes SET claimed_by = 'human' WHERE id = ?").run(human.id);
    expect(() => beginRun(h.db, getNodeRow(h.db, human.id), randomUUID(), "unused.log")).toThrow(/already claimed/);
    expect(getNodeRow(h.db, human.id).claimed_by).toBe("human");
    expect(runsOn(human.id)).toBe(0);

    // A row read before another start took the claim still can't start a second run.
    const free = await h.create("dev");
    const stale = getNodeRow(h.db, free.id);
    beginRun(h.db, stale, randomUUID(), "unused.log");
    expect(() => beginRun(h.db, stale, randomUUID(), "unused.log")).toThrow(/already claimed/);
    expect(runsOn(free.id)).toBe(1);
  });
});

describe("an agent's own fail", () => {
  it("is a report like next or ask: the agent gets its grace period to exit", TIMEOUT, async () => {
    const w = await world({ graceMs: 5_000 });
    const node = await w.create(directives(toolCall("fail", { reason: "The repo is gone" }), "sleep 1500"));
    await w.atStage(node.id, "failed");
    const [run] = await w.runsEnded(node.id);
    expect(run).toMatchObject({ left_via: "fail", left_actor: "agent", end_reason: "reported" });
    expect(await w.call<string>("GET", `/runs/${run!.id}/log`)).toMatchObject({ body: expect.stringContaining("exited, code 0") });
  });
});

describe("shutdown", () => {
  it("during startup, starts no agents afterwards", TIMEOUT, async () => {
    const outer = process.env["AOP_HOME"];
    process.env["AOP_HOME"] = makeHome({ "config.yaml": fakeConfig() });
    const db = openDb();
    const orchestrator = new Orchestrator(db, { changes: new ChangeFeed() });
    onTestFinished(async () => {
      await orchestrator.shutdown();
      db.close();
      process.env["AOP_HOME"] = outer;
    });
    const project = addProject(db, { repo_path: makeRepo() });
    const node = createNode(db, project.id, { type: "hotfix", title: "Queued", body: directives("hang"), actor: "human" });

    // Ctrl+C while the startup sweep is still going.
    const starting = orchestrator.start("http://127.0.0.1:9/mcp");
    await orchestrator.shutdown();
    await starting;
    await settle(500);
    expect(db.prepare("SELECT count(*) AS n FROM runs WHERE node_id = ?").get(node.id)).toEqual({ n: 0 });
  });
});

describe("recovery", () => {
  it("kills what a run launched when a crash came before its process was recorded", TIMEOUT, async () => {
    const w = await world();
    const node = await w.create("", { type: "dev", stage: "pr_review" });
    // The state a crash just after `beginRun` leaves: a `running` row, a claim, and no process row.
    const run = beginRun(w.db, getNodeRow(w.db, node.id), randomUUID(), w.file("lost.log"));
    const marked = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      env: { ...process.env, AOP_RUN_ID: run.id },
      stdio: "ignore",
      windowsHide: true,
    });
    onTestFinished(() => {
      if (marked.exitCode === null) marked.kill();
    });
    const pid = marked.pid!;
    expect(isAlive(pid)).toBe(true);

    await w.restartOrchestrator();
    expect(await waitGone(pid, 10_000)).toBe(true);
    expect(w.runs(node.id)[0]).toMatchObject({ status: "exited", end_reason: "failed" });
  });
});

describe("config.yaml", () => {
  it("reads ~ in the stages path as the user's home, as it does for open_from", () => {
    const home = makeHome({ "config.yaml": "agent_session_command: x\nstages: ~/no-such-folder-for-aop/stages.yaml\n" });
    try {
      loadConfig(home);
      expect.unreachable();
    } catch (error) {
      const problems = (error as { problems: string[] }).problems.join("\n");
      expect(problems).toContain("no-such-folder-for-aop");
      expect(problems).not.toContain(join(home, "~"));
    }
  });
});
