import { describe, expect, it } from "vitest";
import type { EventView } from "../../src/shared/api.js";
import { mcpHarness, resultText } from "./helpers.js";

describe("the next tool", () => {
  it("finishes the node's stage with the outcome, as the agent", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    expect(await m.text("next", { node_id: node.id, outcome: "done" })).toBe(`${node.id} is now at spec_review`);
    expect((await m.node(node.id)).stage).toBe("spec_review");
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "stage_changed")).toMatchObject({ actor: "agent", data: { via: "next", outcome: "done" } });
  });

  it("fails with the API's message for an outcome that isn't available", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const result = await m.tool("next", { node_id: node.id, outcome: "approve" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Outcome "approve" isn't available at stage "write_spec"/);
    expect(resultText(result)).toContain('"available_outcomes":["done"]');
    expect((await m.node(node.id)).stage).toBe("write_spec");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("next", { node_id: "no-such-node", outcome: "done" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with node_id and outcome required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "next");
    expect(tool?.description).toMatch(/Moving on/);
    expect(tool?.description).toMatch(/ends your turn/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "outcome"]);
  });
});
