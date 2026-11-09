import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aopHome } from "../../src/server/paths.js";
import type { ImprovementView, NodeView } from "../../src/shared/api.js";
import { CONFIG_YAML } from "../server/helpers.js";
import { mcpHarness, resultText, type McpHarness } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");

/** Improvements switched on, as in `test/server/improvements.test.ts`. */
const IMPROVEMENTS = {
  "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\nimprovements_path: ./skills\n`,
  "improvement_stages.yaml": readFileSync(join(ROOT, "defaults", "improvement_stages.yaml"), "utf8"),
  "prompts/draft_change.md": "Draft it.",
  "prompts/save_locally.md": "Save it.",
  "prompts/raise_pr.md": "Raise it.",
  "skills/write-tests/SKILL.md": "Old skill.\n",
};

const skills = () => join(aopHome(), "skills");
const skill = () => join(skills(), "write-tests", "SKILL.md");

/** An improvement proposing new contents for the skill, taken by a human to `outcome` after drafting. */
async function improvement(m: McpHarness, outcome?: string): Promise<NodeView> {
  const { node } = (await m.call<ImprovementView>("POST", "/api/improvements", { body: "x" })).body;
  expect((await m.call("PUT", `/api/improvements/${node.id}/proposals`, { path: skill(), content: "New.\n", actor: "agent" })).status).toBe(200);
  if (outcome === undefined) return node;
  expect((await m.post(node.id, "next", { outcome: "drafted", actor: "agent" })).status).toBe(200);
  const res = await m.post(node.id, "next", { outcome, actor: "human" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe("the apply tool", () => {
  it("writes the proposals to the real files at save_locally", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    const node = await improvement(m, "save_locally");
    expect(await m.text("apply", { node_id: node.id, run_id: await m.run(node.id) })).toBe(`Wrote ${skill()}`);
    expect(readFileSync(skill(), "utf8")).toBe("New.\n");
  });

  it("writes into another checkout at raise_pr, leaving the real files alone", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    mkdirSync(join(skills(), ".git"));
    const worktree = mkdtempSync(join(aopHome(), "worktree-"));
    mkdirSync(join(worktree, ".git"));
    const node = await improvement(m, "raise_pr");
    const written = join(worktree, "write-tests", "SKILL.md");
    expect(await m.text("apply", { node_id: node.id, run_id: await m.run(node.id), into: worktree })).toBe(`Wrote ${written}`);
    expect(readFileSync(written, "utf8")).toBe("New.\n");
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
  });

  it("refuses a relative into", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    mkdirSync(join(skills(), ".git"));
    const node = await improvement(m, "raise_pr");
    const result = await m.tool("apply", { node_id: node.id, run_id: await m.run(node.id), into: "worktree" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/full path/);
  });

  it("fails with the API's message before save_locally, writing nothing", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    const node = await improvement(m);
    const result = await m.tool("apply", { node_id: node.id, run_id: await m.run(node.id) });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/only at save_locally, and this improvement is at draft_change/);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
  });

  it("is listed with node_id and run_id required and into optional", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "apply");
    expect(tool?.description).toMatch(/save_locally/);
    expect(tool?.description).toMatch(/raise_pr/);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["into", "node_id", "run_id"]);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "run_id"]);
    expect(tool?.annotations).toBeUndefined();
  });
});
