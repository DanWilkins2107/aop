import { describe, expect, it } from "vitest";
import type { EdgeRow, EventView } from "../../src/shared/api/types.js";
import { mcpHarness, resultText, type McpHarness } from "./helpers.js";

const activeEdges = async (m: McpHarness, nodeId: string) => (await m.call<EdgeRow[]>("GET", `/api/nodes/${nodeId}/edges`)).body;

describe("the edge_add tool", () => {
  it("makes from block to, as the agent", async () => {
    const m = await mcpHarness();
    const a = await m.create("dev");
    const b = await m.create("dev");
    expect(await m.text("edge_add", { run_id: await m.run(), from: a.id, to: b.id })).toBe(`${a.id} now blocks ${b.id}`);
    expect((await activeEdges(m, a.id)).map((e) => [e.kind, e.source_id, e.target_id])).toEqual([["blocks", a.id, b.id]]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${a.id}/events`)).body;
    expect(events.find((e) => e.kind === "edge_added")).toMatchObject({ actor: "agent", data: { kind: "blocks", target_id: b.id } });
  });

  it("fails with the API's message for a cycle", async () => {
    const m = await mcpHarness();
    const a = await m.create("dev");
    const b = await m.create("dev");
    await m.text("edge_add", { run_id: await m.run(), from: a.id, to: b.id });
    const result = await m.tool("edge_add", { run_id: await m.run(), from: b.id, to: a.id });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/would create a blocks cycle/);
    expect(await activeEdges(m, a.id)).toHaveLength(1);
  });

  it("fails for a node blocking itself", async () => {
    const m = await mcpHarness();
    const a = await m.create("dev");
    const result = await m.tool("edge_add", { run_id: await m.run(), from: a.id, to: a.id });
    expect(result.isError).toBe(true);
    expect(await activeEdges(m, a.id)).toEqual([]);
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const a = await m.create("dev");
    const result = await m.tool("edge_add", { run_id: await m.run(), from: a.id, to: "no-such-node" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });
});

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
});

describe("the edge tools", () => {
  it("are listed, each with run_id, from and to required", async () => {
    const m = await mcpHarness();
    const tools = await m.tools();
    const add = tools.find((t) => t.name === "edge_add");
    const remove = tools.find((t) => t.name === "edge_remove");
    expect(add?.description).toMatch(/`from` must finish before `to` starts/);
    expect(remove?.description).toMatch(/Remove a block/);
    for (const tool of [add, remove]) {
      expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["from", "run_id", "to"]);
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["from", "run_id", "to"]);
      expect(tool?.annotations).toBeUndefined();
    }
  });
});
