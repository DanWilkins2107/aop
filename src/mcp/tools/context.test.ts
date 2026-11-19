import { describe, expect, it } from "vitest";
import { nodeContext } from "../../server/runs/context.js";
import { mcpHarness } from "../test-shared/mcpHarness.helpers.js";
import { resultText } from "../test-shared/resultText.helpers.js";

describe("the context tool", () => {
  it("returns a node's context, as the context route gives it", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev", { title: "Write the importer" });
    const text = await m.text("context", { node_id: node.id });
    expect(text).toBe(nodeContext(m.db, node.id));
    expect(text).toContain("Write the importer");
    expect(text).toContain(node.id);
  });

  it("sends a run_id as the run's, which a run on no branch doesn't change", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    expect(await m.text("context", { node_id: node.id, run_id: "some-run" })).toBe(nodeContext(m.db, node.id));
  });

  it("fails with the API's message for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("context", { node_id: "no-such-node" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("refuses a call without a node_id", async () => {
    const m = await mcpHarness();
    const result = await m.tool("context", {});
    expect(result.isError).toBe(true);
  });

  it("is listed, with node_id required", async () => {
    const m = await mcpHarness();
    const tool = await m.listed("context");
    expect(tool.description).toMatch(/Moving on/);
    expect(tool.required).toEqual(["node_id"]);
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});
