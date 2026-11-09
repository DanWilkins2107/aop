import { describe, expect, it } from "vitest";
import type { EventView, NodeView } from "../../src/shared/api.js";
import { mcpHarness, resultText, type McpHarness } from "./helpers.js";

/** A triage node at `split_approved`, the agent stage that begins a split in these tests. */
async function atSplitApproved(m: McpHarness): Promise<NodeView> {
  const node = await m.create("triage");
  await m.post(node.id, "next", { outcome: "split" });
  return (await m.post(node.id, "next", { outcome: "approve" })).body;
}

describe("the split tools", () => {
  it("start a split holding new children, then finish it to broken_down, releasing them", async () => {
    const m = await mcpHarness();
    const node = await atSplitApproved(m);
    expect(await m.text("split_start", { node_id: node.id })).toBe(`${node.id} is now at splitting`);
    expect(await m.node(node.id)).toMatchObject({ stage: "splitting", return_stage: "split_approved" });

    const child = await m.create("dev", { parent_id: node.id });
    expect(await m.node(child.id)).toMatchObject({ held: true, held_by: [node.id] });

    expect(await m.text("split_finish", { node_id: node.id })).toBe(`${node.id} is now at broken_down`);
    expect((await m.node(node.id)).stage).toBe("broken_down");
    expect(await m.node(child.id)).toMatchObject({ held: false, held_by: [] });

    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    const vias = events.filter((e) => e.kind === "stage_changed").map((e) => [e.actor, (e.data as { via: string }).via]);
    expect(vias.slice(-2)).toEqual([["agent", "split_start"], ["agent", "split_finish"]]);
  });

  it("fails to finish a split that wasn't started", async () => {
    const m = await mcpHarness();
    const node = await atSplitApproved(m);
    const result = await m.tool("split_finish", { node_id: node.id });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Can't finish a split: the node is at "split_approved", not splitting/);
    expect((await m.node(node.id)).stage).toBe("split_approved");
  });

  it("fails to start a split from a human stage", async () => {
    const m = await mcpHarness();
    const node = await m.create("triage");
    await m.post(node.id, "next", { outcome: "split" });
    const result = await m.tool("split_start", { node_id: node.id });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/split_proposed/);
    expect((await m.node(node.id)).stage).toBe("split_proposed");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    for (const name of ["split_start", "split_finish"]) {
      const result = await m.tool(name, { node_id: "no-such-node" });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/no-such-node/);
    }
  });

  it("are listed, each with only node_id, and only finish ends the turn", async () => {
    const m = await mcpHarness();
    const tools = await m.tools();
    const start = tools.find((t) => t.name === "split_start");
    const finish = tools.find((t) => t.name === "split_finish");
    expect(start?.description).toMatch(/held/);
    expect(start?.description).not.toMatch(/ends your turn/);
    expect(finish?.description).toMatch(/broken_down/);
    expect(finish?.description).toMatch(/ends your turn/);
    for (const tool of [start, finish]) {
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["node_id"]);
      expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id"]);
    }
  });
});
