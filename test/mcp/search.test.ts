import { describe, expect, it } from "vitest";
import { addProject } from "../../src/server/projects.js";
import type { NodeView } from "../../src/shared/api.js";
import { makeRepo } from "../server/helpers.js";
import { mcpHarness, resultText } from "./helpers.js";

describe("the search tool", () => {
  it("keeps to the node's project, unless all", async () => {
    const m = await mcpHarness();
    const here = await m.create("dev", { title: "Zebra here" });
    const other = addProject(m.db, { repo_path: makeRepo() });
    const there = await m.call<NodeView>("POST", `/api/projects/${other.id}/nodes`, { type: "dev", title: "Zebra there" });
    expect(there.status).toBe(201);

    const scoped = await m.text("search", { query: "Zebra", node_id: here.id });
    expect(scoped).toBe(`${here.id}  [${here.stage}]  Zebra here\n    [Zebra] here`);

    const all = await m.text("search", { query: "Zebra", node_id: here.id, all: true });
    expect(all).toContain(`${here.id}  [${here.stage}]  Zebra here`);
    expect(all).toContain(`${there.body.id}  [${there.body.stage}]  Zebra there`);
  });

  it("says when nothing matches", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    expect(await m.text("search", { query: "Quagga", node_id: node.id })).toBe("No matches.");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("search", { query: "Zebra", node_id: "no-such-node" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with query and node_id required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "search");
    expect(tool?.description).toMatch(/every project/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "query"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["all", "node_id", "query"]);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });
});
