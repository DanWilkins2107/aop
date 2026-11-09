import { describe, expect, it } from "vitest";
import { addProject } from "../../src/server/projects.js";
import type { EventView, NodeView } from "../../src/shared/api.js";
import { makeRepo } from "../server/helpers.js";
import { mcpHarness, resultText, type McpHarness } from "./helpers.js";

/** The node a tool's "Created <id> at <stage>" names. */
async function created(m: McpHarness, text: string): Promise<NodeView> {
  const match = /^Created (\S+) at (\S+)$/.exec(text);
  if (!match) throw new Error(`Unexpected result: ${text}`);
  const node = await m.node(match[1]!);
  expect(node.stage).toBe(match[2]);
  return node;
}

describe("the node_create tool", () => {
  it("creates at the top-level start in the calling node's project, as the agent", async () => {
    const m = await mcpHarness();
    const own = await m.create("dev");
    const node = await created(m, await m.text("node_create", { node_id: own.id, title: "New work", body: "Details" }));
    expect(node).toMatchObject({ project_id: m.projectId, title: "New work", body: "Details", type: "triage", stage: "awaiting_agent_breakdown" });
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "node_created")).toMatchObject({ actor: "agent" });
  });

  it("creates under a parent, in the parent's project", async () => {
    const m = await mcpHarness();
    const other = addProject(m.db, { repo_path: makeRepo(), name: "other" });
    const own = await m.create("dev");
    const parent = (await m.call<NodeView>("POST", `/api/projects/${other.id}/nodes`, { type: "dev", title: "Parent" })).body;
    const node = await created(m, await m.text("node_create", { node_id: own.id, title: "Child", parent: parent.id }));
    expect(node.project_id).toBe(other.id);
    const edges = (await m.call<{ source_id: string; target_id: string; kind: string }[]>("GET", `/api/projects/${other.id}/edges`)).body;
    expect(edges).toContainEqual(expect.objectContaining({ source_id: parent.id, target_id: node.id, kind: "subtask" }));
  });

  it("creates in a project named by name", async () => {
    const m = await mcpHarness();
    const other = addProject(m.db, { repo_path: makeRepo(), name: "other" });
    const own = await m.create("dev");
    const node = await created(m, await m.text("node_create", { node_id: own.id, title: "Elsewhere", project: "other" }));
    expect(node.project_id).toBe(other.id);
  });

  it("starts at a type's first stage, or exactly at a stage", async () => {
    const m = await mcpHarness();
    const own = await m.create("dev");
    const byType = await created(m, await m.text("node_create", { node_id: own.id, title: "Fix", type: "hotfix" }));
    expect(byType).toMatchObject({ type: "hotfix", stage: "implement" });
    const byStage = await created(m, await m.text("node_create", { node_id: own.id, title: "Review", stage: "spec_review" }));
    expect(byStage).toMatchObject({ type: "dev", stage: "spec_review" });
  });

  it("refuses type and stage together", async () => {
    const m = await mcpHarness();
    const own = await m.create("dev");
    const result = await m.tool("node_create", { node_id: own.id, title: "Both", type: "dev", stage: "implement" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/type or stage, not both/);
  });

  it("fails for an unknown project, with the CLI's message", async () => {
    const m = await mcpHarness();
    const own = await m.create("dev");
    const result = await m.tool("node_create", { node_id: own.id, title: "Lost", project: "nowhere" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('No project "nowhere"');
  });

  it("fails with the API's message for a bad type", async () => {
    const m = await mcpHarness();
    const own = await m.create("dev");
    const before = (await m.call<NodeView[]>("GET", `/api/projects/${m.projectId}/nodes`)).body.length;
    const result = await m.tool("node_create", { node_id: own.id, title: "Odd", type: "nope" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Unknown type "nope"/);
    expect((await m.call<NodeView[]>("GET", `/api/projects/${m.projectId}/nodes`)).body).toHaveLength(before);
  });

  it("fails for an unknown calling node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("node_create", { node_id: "no-such-node", title: "Orphan" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with node_id and title required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "node_create");
    expect(tool?.description).toMatch(/first stage/);
    expect(tool?.description).toMatch(/held until the split finishes/);
    expect(tool?.annotations).toBeUndefined();
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "title"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["body", "node_id", "parent", "project", "stage", "title", "type"]);
  });
});
