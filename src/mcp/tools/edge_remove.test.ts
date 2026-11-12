import { describe, expect, it } from "vitest";
import type { EdgeRow } from "../../shared/nodes/types.js";
import type { EventView } from "../../shared/events/types.js";
import { mcpHarness, resultText, type McpHarness } from "../shared/mcpHarness.helpers.js";

const activeEdges = async (m: McpHarness, nodeId: string) => (await m.call<EdgeRow[]>("GET", `/api/nodes/${nodeId}/edges`)).body;

describe("the edge_remove tool", () => {
  it("removes the block, as the agent", async () => {
    const m = await mcpHarness();
    const a = await m.create("dev");
    const b = await m.create("dev");
    await m.text("edge_add", { run_id: await m.run(), from: a.id, to: b.id });
    expect(await m.text("edge_remove", { run_id: await m.run(), from: a.id, to: b.id })).toBe(`${a.id} no longer blocks ${b.id}`);
    expect(await activeEdges(m, a.id)).toEqual([]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${a.id}/events`)).body;
    expect(events.find((e) => e.kind === "edge_removed")).toMatchObject({ actor: "agent", data: { kind: "blocks", target_id: b.id } });
  });

  it("fails when from doesn't block to, even if to blocks from", async () => {
    const m = await mcpHarness();
    const a = await m.create("dev");
    const b = await m.create("dev");
    await m.text("edge_add", { run_id: await m.run(), from: b.id, to: a.id });
    const result = await m.tool("edge_remove", { run_id: await m.run(), from: a.id, to: b.id });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`${a.id} doesn't block ${b.id}`);
    expect(await activeEdges(m, a.id)).toHaveLength(1);
  });

  it("is listed, with run_id, from and to required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "edge_remove");
    expect(tool?.description).toMatch(/Remove a block/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["from", "run_id", "to"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["from", "run_id", "to"]);
    expect(tool?.annotations).toBeUndefined();
  });
});
