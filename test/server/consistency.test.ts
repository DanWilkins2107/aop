import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { aopInProcess } from "../cli/cli.helpers.js";
import { directives, fakeConfig, settle, world } from "./agents.helpers.js";
import { harness, makeHome, makeRepo, STAGES_YAML } from "./helpers.js";

const TIMEOUT = { timeout: 90_000 };

/** The CLI in-process, with exactly this environment on top of the test's. */
async function aop(args: string[], env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  const res = await aopInProcess(args, env);
  return { code: res.code, output: res.stdout + res.stderr };
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
      directives('ifnot Stage: write_spec :: aop ["next","fixed"]', "ifnot Stage: write_spec :: exit 0", "hang"),
    );
    const second = await w.runStarted(node.id, 2);
    const [first] = w.runs(node.id);
    expect(first).toMatchObject({ status: "exited", end_reason: "reported" });

    // What a process the first run left behind would run: it still carries that run's marker.
    const stale = await aop(["next", "again"], { AOP_URL: w.url, AOP_NODE_ID: node.id, AOP_RUN_ID: first!.id });
    expect(stale.code).toBe(1);
    expect(stale.output).toContain("has ended");
    expect(w.node(node.id).stage).toBe("write_spec");
    expect(w.runs(node.id)[1]).toMatchObject({ id: second.id, status: "running", left_via: null });

    // Its other writes are refused too, while the current run's go through.
    const message = await aop(["message", "stale"], { AOP_URL: w.url, AOP_NODE_ID: node.id, AOP_RUN_ID: first!.id });
    expect(message.code).toBe(1);
    const current = await aop(["next", "again"], { AOP_URL: w.url, AOP_NODE_ID: node.id, AOP_RUN_ID: second.id });
    expect(current.code).toBe(0);
    expect(w.node(node.id).stage).toBe("done");
  });

  it("refuses a run's stage change on a node that isn't the run's", TIMEOUT, async () => {
    const w = await world();
    const node = await w.create(directives("hang"));
    const run = await w.runStarted(node.id);
    // Held from the moment it exists, by an invalidated parent, so no run of its own starts on it.
    const parent = await w.create("", { type: "dev", stage: "pr_review" });
    await w.call("POST", `/nodes/${parent.id}/invalidate`, { reason: "Hold the child" });
    const other = await w.create("", { parent_id: parent.id });
    const res = await aop(["next", "fixed"], { AOP_URL: w.url, AOP_NODE_ID: other.id, AOP_RUN_ID: run.id });
    expect(res.code).toBe(1);
    expect((w.node(other.id) as NodeView).stage).toBe("implement");
    expect(w.runs(other.id)).toEqual([]);
  });
});

describe("an agent's own fail", () => {
  it("is a report like next or ask: the agent gets its grace period to exit", TIMEOUT, async () => {
    const w = await world({ graceMs: 5_000 });
    const node = await w.create(directives('aop ["fail","The repo is gone"]', "sleep 1500"));
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
    const starting = orchestrator.start("http://127.0.0.1:9");
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
