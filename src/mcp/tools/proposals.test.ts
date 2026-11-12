import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aopHome } from "../../server/paths.js";
import type { ImprovementView, ProposalView } from "../../shared/improvements/types.js";
import { CONFIG_YAML } from "../../../test/server/helpers.js";
import { mcpHarness, resultText, type McpHarness } from "../shared/mcpHarness.helpers.js";

const ROOT = resolve(import.meta.dirname, "../../..");

/** An MCP harness with improvements on, and an improvement node to propose on. */
async function improvement(): Promise<{ m: McpHarness; id: string }> {
  const m = await mcpHarness({
    "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\nimprovements_path: ./skills\n`,
    "improvement_stages.yaml": readFileSync(join(ROOT, "defaults", "improvement_stages.yaml"), "utf8"),
    "prompts/draft_change.md": "Draft it.",
    "prompts/raise_pr.md": "Raise it.",
    "skills/write-tests/SKILL.md": "Old skill.\n",
  });
  const res = await m.call<ImprovementView>("POST", "/api/improvements", { body: "Better tests" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { m, id: res.body.node.id };
}

const skill = () => join(aopHome(), "skills", "write-tests", "SKILL.md");
const fresh = () => join(aopHome(), "skills", "new-skill", "SKILL.md");

async function propose(m: McpHarness, id: string, path: string, content: string): Promise<void> {
  const res = await m.call<ProposalView>("PUT", `/api/improvements/${id}/proposals`, { path, content, actor: "agent" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe("the proposals tool", () => {
  it("says when there are none", async () => {
    const { m, id } = await improvement();
    expect(await m.text("proposals", { node_id: id })).toBe("No proposals.");
  });

  it("lists new files and changed ones", async () => {
    const { m, id } = await improvement();
    await propose(m, id, skill(), "New skill.\n");
    await propose(m, id, fresh(), "Brand new.\n");
    expect(await m.text("proposals", { node_id: id })).toBe(
      `${fresh()}  (new file, last by agent)\n${skill()}  (changes the file, last by agent)`,
    );
  });

  it("shows one by absolute path or display path", async () => {
    const { m, id } = await improvement();
    await propose(m, id, skill(), "New skill.\n");
    await propose(m, id, fresh(), "Brand new.\n");
    expect(await m.text("proposals", { node_id: id, show: skill().toUpperCase() })).toBe("New skill.\n");
    expect(await m.text("proposals", { node_id: id, show: "new-skill/SKILL.md" })).toBe("Brand new.\n");
  });

  it("fails for a path with no proposal", async () => {
    const { m, id } = await improvement();
    await propose(m, id, skill(), "New skill.\n");
    const result = await m.tool("proposals", { node_id: id, show: "other/SKILL.md" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("No proposal for other/SKILL.md");
  });

  it("is listed as a read, with node_id required", async () => {
    const { m } = await improvement();
    const tool = (await m.tools()).find((t) => t.name === "proposals");
    expect(tool?.description).toMatch(/proposed contents/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["node_id", "show"]);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });
});
