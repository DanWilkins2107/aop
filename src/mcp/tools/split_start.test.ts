import { describe, expect, it } from "vitest";
import { mcpHarness, resultText } from "../shared/mcpHarness.helpers.js";

describe("the split_start tool", () => {
  it("fails from a human stage", async () => {
    const m = await mcpHarness();
    const node = await m.create("triage");
    await m.post(node.id, "next", { outcome: "split" });
    const result = await m.tool("split_start", { node_id: node.id, run_id: await m.run(node.id) });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/split_proposed/);
    expect((await m.node(node.id)).stage).toBe("split_proposed");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("split_start", { node_id: "no-such-node", run_id: await m.run() });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with only node_id and run_id, and doesn't end the turn", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "split_start");
    expect(tool?.description).toMatch(/held/);
    expect(tool?.description).not.toMatch(/ends your turn/);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["node_id", "run_id"]);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "run_id"]);
  });
});
