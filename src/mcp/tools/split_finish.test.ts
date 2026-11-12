import { describe, expect, it } from "vitest";
import type { EventView } from "../../shared/events/types.js";
import type { NodeView } from "../../shared/nodes/types.js";
import { mcpHarness, resultText, type McpHarness } from "../shared/mcpHarness.helpers.js";

/** A triage node at `split_approved`, the agent stage that begins a split in these tests. */
async function atSplitApproved(m: McpHarness): Promise<NodeView> {
  const node = await m.create("triage");
  await m.post(node.id, "next", { outcome: "split" });
  return (await m.post(node.id, "next", { outcome: "approve" })).body;
}

describe("the split_finish tool", () => {
  it("finishes a started split, which held new children, to broken_down, releasing them", async () => {
    const m = await mcpHarness();
    const node = await atSplitApproved(m);
    const run_id = await m.run(node.id);
    expect(await m.text("split_start", { node_id: node.id, run_id })).toBe(`${node.id} is now at splitting`);
    expect(await m.node(node.id)).toMatchObject({ stage: "splitting", return_stage: "split_approved" });

    const child = await m.create("dev", { parent_id: node.id });
    expect(await m.node(child.id)).toMatchObject({ held: true, held_by: [node.id] });

    expect(await m.text("split_finish", { node_id: node.id, run_id })).toBe(`${node.id} is now at broken_down`);
    expect((await m.node(node.id)).stage).toBe("broken_down");
    expect(await m.node(child.id)).toMatchObject({ held: false, held_by: [] });

    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    const vias = events.filter((e) => e.kind === "stage_changed").map((e) => [e.actor, (e.data as { via: string }).via]);
    expect(vias.slice(-2)).toEqual([["agent", "split_start"], ["agent", "split_finish"]]);
  });

  it("fails for a split that wasn't started", async () => {
    const m = await mcpHarness();
    const node = await atSplitApproved(m);
    const result = await m.tool("split_finish", { node_id: node.id, run_id: await m.run(node.id) });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Can't finish a split: the node is at "split_approved", not splitting/);
    expect((await m.node(node.id)).stage).toBe("split_approved");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("split_finish", { node_id: "no-such-node", run_id: await m.run() });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with only node_id and run_id, and ends the turn", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "split_finish");
    expect(tool?.description).toMatch(/broken_down/);
    expect(tool?.description).toMatch(/ends your turn/);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["node_id", "run_id"]);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "run_id"]);
  });
});
