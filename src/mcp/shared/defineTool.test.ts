import { describe, expect, it } from "vitest";
import { TOOLS } from "../tools/registry.js";
import { deleteProject } from "../../server/projects.js";
import { closeRun, getRun } from "../../server/runs.js";
import type { MessageRow } from "../../shared/nodes/types.js";
import type { SteerSession } from "../../shared/runs/types.js";
import { mcpHarness, resultText, type McpHarness } from "./mcpHarness.helpers.js";

const READS = ["context", "proposals", "search"];

const messagesOn = async (m: McpHarness, nodeId: string) => (await m.call<MessageRow[]>("GET", `/api/nodes/${nodeId}/messages`)).body;

/** Opens a steered session on the node, as `aop steer` does, and returns its ID. */
async function steer(m: McpHarness, nodeId: string): Promise<string> {
  const res = await m.call<SteerSession>("POST", `/api/nodes/${nodeId}/steer`, { no_sandbox: false });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.steer_id;
}

describe("run_id on the MCP tools", () => {
  it("is required by every write tool, and taken by no read", async () => {
    const m = await mcpHarness();
    const listed = await m.tools();
    expect(listed.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const tool of listed) {
      const required = tool.inputSchema.required ?? [];
      if (READS.includes(tool.name)) expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).not.toContain("run_id");
      else expect(required, tool.name).toContain("run_id");
    }
    const next = listed.find((t) => t.name === "next");
    expect(JSON.stringify(next?.inputSchema.properties?.["run_id"])).toMatch(/Your run ID, from your prompt/);
  });

  it("is a schema error when missing, and nothing is written", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    for (const [name, args] of [
      ["next", { node_id: node.id, outcome: "done" }],
      ["message", { node_id: node.id, body: "Hi" }],
      ["message", { node_id: node.id, run_id: "", body: "Hi" }],
    ] as const) {
      const result = await m.tool(name, args);
      expect(result.isError, name).toBe(true);
      expect(resultText(result)).toMatch(/run_id/);
    }
    expect((await m.node(node.id)).stage).toBe("write_spec");
    expect(await messagesOn(m, node.id)).toEqual([]);
  });
});

describe("the run guard, through the tools", () => {
  it("refuses any write from a run that has ended", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const run = await m.run(node.id);
    closeRun(m.db, getRun(m.db, run)!, "stopped", null);
    for (const [name, args] of [
      ["next", { node_id: node.id, outcome: "done" }],
      ["message", { node_id: node.id, body: "Still here" }],
      ["node_edit", { node_id: node.id, title: "Renamed" }],
    ] as const) {
      const result = await m.tool(name, { ...args, run_id: run });
      expect(result.isError, name).toBe(true);
      expect(resultText(result)).toBe(`Agent run ${run} has ended, so it can't change anything. It should exit`);
    }
    expect(await m.node(node.id)).toMatchObject({ stage: "write_spec", title: "A dev node" });
    expect(await messagesOn(m, node.id)).toEqual([]);
  });

  it("refuses an unknown run ID", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const result = await m.tool("message", { node_id: node.id, run_id: "not-a-run", body: "Hi" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/has ended/);
  });

  it("refuses a stage move from another node's run", async () => {
    const m = await mcpHarness();
    const own = await m.create("dev");
    const other = await m.create("dev");
    const run = await m.run(own.id);
    for (const name of ["next", "ask", "fail", "split_start"]) {
      const result = await m.tool(name, { node_id: other.id, run_id: run, outcome: "done", question: "?", reason: "x" });
      expect(result.isError, name).toBe(true);
      expect(resultText(result)).toBe(`Agent run ${run} isn't the run on node ${other.id}, so it can't move it`);
    }
    expect((await m.node(other.id)).stage).toBe("write_spec");
    // Its other writes still reach other nodes, as an agent's must.
    expect(await m.text("message", { node_id: other.id, run_id: run, body: "Heads up" })).toBe(`Posted to ${other.id}`);
  });

  it("refuses a second move from a run that has already moved its node", async () => {
    const m = await mcpHarness();
    const node = await m.create("hotfix");
    const run = await m.run(node.id);
    await m.text("ask", { node_id: node.id, run_id: run, question: "Which way?" });
    const result = await m.tool("fail", { node_id: node.id, run_id: run, reason: "Changed my mind" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/already moved the node on/);
  });
});

describe("a steered session's ID", () => {
  it("is the same while the claim holds, and new after it's released", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const first = await steer(m, node.id);
    expect(await steer(m, node.id)).toBe(first);
    expect((await m.post(node.id, "release", { actor: "human" })).status).toBe(200);
    expect(await steer(m, node.id)).not.toBe(first);
  });

  it("writes and moves its own node while the human's claim holds", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const steerId = await steer(m, node.id);
    expect(await m.text("message", { node_id: node.id, run_id: steerId, body: "From the session" })).toBe(`Posted to ${node.id}`);
    expect(await m.text("next", { node_id: node.id, run_id: steerId, outcome: "done" })).toBe(`${node.id} is now at spec_review`);
    // A steered session isn't the agent run: the claim stays the human's.
    expect((await m.node(node.id)).claimed_by).toBe("human");
  });

  it("can't move another node, though it can write to one", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const other = await m.create("dev");
    const steerId = await steer(m, node.id);
    const result = await m.tool("next", { node_id: other.id, run_id: steerId, outcome: "done" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`Steered session ${steerId} is on node ${node.id}, so it can't move node ${other.id}`);
    expect((await m.node(other.id)).stage).toBe("write_spec");
    expect(await m.text("message", { node_id: other.id, run_id: steerId, body: "Heads up" })).toBe(`Posted to ${other.id}`);
  });

  it("is refused once the claim is released, even after a new claim", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const steerId = await steer(m, node.id);
    expect((await m.post(node.id, "release", { actor: "human" })).status).toBe(200);
    for (const [name, args] of [
      ["message", { node_id: node.id, body: "Too late" }],
      ["next", { node_id: node.id, outcome: "done" }],
    ] as const) {
      const result = await m.tool(name, { ...args, run_id: steerId });
      expect(result.isError, name).toBe(true);
      expect(resultText(result)).toMatch(/has ended/);
    }
    // A claim taken again some other way doesn't revive it.
    expect((await m.post(node.id, "claim", { actor: "human" })).status).toBe(200);
    expect((await m.tool("message", { node_id: node.id, run_id: steerId, body: "Still too late" })).isError).toBe(true);
    expect(await messagesOn(m, node.id)).toEqual([]);
    expect((await m.node(node.id)).stage).toBe("write_spec");
  });

  it("can't exist without the human's claim, and never reopens", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const insert = (id: string) =>
      m.db.prepare("INSERT INTO steer_sessions (id, created_at, node_id) VALUES (?, ?, ?)").run(id, new Date().toISOString(), node.id);
    expect(() => insert("s1")).toThrow(/needs the human's claim/);
    const steerId = await steer(m, node.id);
    await m.post(node.id, "release", { actor: "human" });
    expect(() => m.db.prepare("UPDATE steer_sessions SET ended_at = NULL WHERE id = ?").run(steerId)).toThrow(/never reopens/);
  });

  it("goes with its project when that's deleted", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    await steer(m, node.id);
    deleteProject(m.db, m.projectId);
    expect(m.db.prepare("SELECT count(*) AS n FROM steer_sessions").get()).toEqual({ n: 0 });
  });
});
