import { describe, expect, it } from "vitest";
import type { EventView, NodeView } from "../../src/shared/api/types.js";
import { mcpHarness, resultText } from "./helpers.js";

describe("the node_edit tool", () => {
  it("edits the title only, as the agent", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev", { title: "Old title", body: "Old body" });
    expect(await m.text("node_edit", { node_id: node.id, run_id: await m.run(node.id), title: "New title" })).toBe(`Edited ${node.id}`);
    const after = (await m.call<NodeView>("GET", `/api/nodes/${node.id}`)).body;
    expect([after.title, after.body]).toEqual(["New title", "Old body"]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "title_edited")).toMatchObject({ actor: "agent", data: { previous: "Old title" } });
    expect(events.some((e) => e.kind === "description_edited")).toBe(false);
  });

  it("edits the body only", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev", { title: "Kept", body: "Old body" });
    expect(await m.text("node_edit", { node_id: node.id, run_id: await m.run(node.id), body: "New body" })).toBe(`Edited ${node.id}`);
    const after = (await m.call<NodeView>("GET", `/api/nodes/${node.id}`)).body;
    expect([after.title, after.body]).toEqual(["Kept", "New body"]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "description_edited")).toMatchObject({ actor: "agent" });
  });

  it("edits the title and body together, recording both", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev", { title: "Old title", body: "Old body" });
    const args = { node_id: node.id, run_id: await m.run(node.id), title: "New title", body: "New body" };
    expect(await m.text("node_edit", args)).toBe(`Edited ${node.id}`);
    const after = (await m.call<NodeView>("GET", `/api/nodes/${node.id}`)).body;
    expect([after.title, after.body]).toEqual(["New title", "New body"]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "title_edited")).toMatchObject({ actor: "agent", data: { previous: "Old title" } });
    expect(events.find((e) => e.kind === "description_edited")).toMatchObject({ actor: "agent" });
  });

  it("refuses when given neither a title nor a body", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev", { title: "Kept" });
    const result = await m.tool("node_edit", { node_id: node.id, run_id: await m.run(node.id) });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/title.*body/);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.some((e) => e.kind === "title_edited" || e.kind === "description_edited")).toBe(false);
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("node_edit", { node_id: "no-such-node", run_id: await m.run(), title: "X" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with only node_id and run_id required and title and body offered", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "node_edit");
    expect(tool?.description).toMatch(/title or description/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "run_id"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["body", "node_id", "run_id", "title"]);
  });
});
