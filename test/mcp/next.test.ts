import { describe, expect, it } from "vitest";
import type { EventView } from "../../src/shared/api/types.js";
import { mcpHarness, resultText } from "./helpers.js";

describe("the next tool", () => {
  it("finishes the node's stage with the outcome, as the agent", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const run_id = await m.run(node.id);
    expect(await m.text("next", { node_id: node.id, run_id, outcome: "done" })).toBe(`${node.id} is now at spec_review`);
    expect((await m.node(node.id)).stage).toBe("spec_review");
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "stage_changed")).toMatchObject({ actor: "agent", data: { via: "next", outcome: "done" } });
  });

  it("fails with the API's message for an outcome that isn't available", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const result = await m.tool("next", { node_id: node.id, run_id: await m.run(node.id), outcome: "approve" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Outcome "approve" isn't available at stage "write_spec"/);
    expect(resultText(result)).toContain('"available_outcomes":["done"]');
    expect((await m.node(node.id)).stage).toBe("write_spec");
  });

  it("fails with the API's message on a human stage", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    await m.post(node.id, "next", { outcome: "done" });
    const result = await m.tool("next", { node_id: node.id, run_id: await m.run(node.id), outcome: "approve" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Stage "spec_review" is a human turn, so an agent can't report its outcome/);
    expect((await m.node(node.id)).stage).toBe("spec_review");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("next", { node_id: "no-such-node", run_id: await m.run(), outcome: "done" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with node_id, run_id and outcome required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "next");
    expect(tool?.description).toMatch(/Moving on/);
    expect(tool?.description).toMatch(/ends your turn/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "outcome", "run_id"]);
  });
});
