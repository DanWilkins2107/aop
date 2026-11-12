import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aopHome } from "../../server/paths.js";
import type { EventView, ImprovementView, ProposalView } from "../../shared/api.js";
import { CONFIG_YAML } from "../../../test/server/helpers.js";
import { mcpHarness, resultText, type McpHarness } from "../shared/mcpHarness.helpers.js";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Improvements switched on, with one skill to change, as in `test/server/improvements.test.ts`. */
const ON = {
  "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\nimprovements_path: ./skills\n`,
  "improvement_stages.yaml": readFileSync(join(ROOT, "defaults", "improvement_stages.yaml"), "utf8"),
  "prompts/draft_change.md": "Draft it.",
  "prompts/raise_pr.md": "Raise it.",
  "skills/write-tests/SKILL.md": "Old skill.\n",
};

const skills = () => join(aopHome(), "skills");
const skill = () => join(skills(), "write-tests", "SKILL.md");

async function improvement(m: McpHarness): Promise<string> {
  const res = await m.call<ImprovementView>("POST", "/api/improvements", { body: "Make the test skill stricter." });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.node.id;
}

const proposals = async (m: McpHarness, id: string) => (await m.call<ProposalView[]>("GET", `/api/improvements/${id}/proposals`)).body;

describe("the propose tool", () => {
  it("proposes a change to an existing file, as the agent, leaving the real file alone", async () => {
    const m = await mcpHarness(ON);
    const id = await improvement(m);
    const run_id = await m.run(id);
    expect(await m.text("propose", { node_id: id, run_id, path: skill(), content: "New skill.\n" })).toBe(
      `Proposed ${skill()}. The real file is unchanged.`,
    );
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
    expect(await proposals(m, id)).toMatchObject([{ path: skill(), proposed: "New skill.\n", current: "Old skill.\n", updated_by: "agent" }]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${id}/events`)).body;
    expect(events.find((e) => e.kind === "proposal_saved")).toMatchObject({ actor: "agent" });
  });

  it("proposes a new file", async () => {
    const m = await mcpHarness(ON);
    const id = await improvement(m);
    const run_id = await m.run(id);
    const fresh = join(skills(), "new-skill", "SKILL.md");
    expect(await m.text("propose", { node_id: id, run_id, path: fresh, content: "Brand new.\n" })).toBe(
      `Proposed ${fresh} (new file). The real file is unchanged.`,
    );
    expect(existsSync(fresh)).toBe(false);
  });

  it("refuses a relative path before asking the API", async () => {
    const m = await mcpHarness(ON);
    const id = await improvement(m);
    const run_id = await m.run(id);
    const result = await m.tool("propose", { node_id: id, run_id, path: "write-tests/SKILL.md", content: "x" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/absolute path/);
    expect(await proposals(m, id)).toEqual([]);
  });

  it("passes on the API's refusal of a path outside what improvements may change", async () => {
    const m = await mcpHarness(ON);
    const id = await improvement(m);
    const run_id = await m.run(id);
    const outside = join(mkdtempSync(join(aopHome(), "outside-")), "SKILL.md");
    const result = await m.tool("propose", { node_id: id, run_id, path: outside, content: "evil" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/is outside .*Improvements can only change those/);
    expect(await proposals(m, id)).toEqual([]);
  });

  it("fails for a node that isn't an improvement", async () => {
    const m = await mcpHarness(ON);
    const work = await m.create("dev");
    const result = await m.tool("propose", { node_id: work.id, run_id: await m.run(work.id), path: skill(), content: "x" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Only improvements have proposals/);
  });
});

describe("the withdraw_proposal tool", () => {
  it("drops a proposal", async () => {
    const m = await mcpHarness(ON);
    const id = await improvement(m);
    const run_id = await m.run(id);
    await m.text("propose", { node_id: id, run_id, path: skill(), content: "New skill.\n" });
    expect(await m.text("withdraw_proposal", { node_id: id, run_id, path: skill() })).toBe(`Withdrew the proposal for ${skill()}`);
    expect(await proposals(m, id)).toEqual([]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${id}/events`)).body;
    expect(events.find((e) => e.kind === "proposal_withdrawn")).toMatchObject({ actor: "agent" });
  });

  it("refuses a relative path", async () => {
    const m = await mcpHarness(ON);
    const id = await improvement(m);
    const run_id = await m.run(id);
    const result = await m.tool("withdraw_proposal", { node_id: id, run_id, path: "write-tests/SKILL.md" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/absolute path/);
  });

  it("passes on the API's refusal when there's no such proposal", async () => {
    const m = await mcpHarness(ON);
    const id = await improvement(m);
    const run_id = await m.run(id);
    const result = await m.tool("withdraw_proposal", { node_id: id, run_id, path: skill() });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/No proposal/);
  });
});

describe("tools/list", () => {
  it("offers propose and withdraw_proposal with all their arguments required, run_id among them", async () => {
    const m = await mcpHarness(ON);
    const tools = await m.tools();
    const propose = tools.find((t) => t.name === "propose");
    expect(propose?.description).toMatch(/real file is unchanged/);
    expect([...(propose?.inputSchema.required ?? [])].sort()).toEqual(["content", "node_id", "path", "run_id"]);
    expect(Object.keys(propose?.inputSchema.properties ?? {}).sort()).toEqual(["content", "node_id", "path", "run_id"]);
    const withdraw = tools.find((t) => t.name === "withdraw_proposal");
    expect(withdraw?.description).toMatch(/Drop/);
    expect([...(withdraw?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "path", "run_id"]);
    expect(Object.keys(withdraw?.inputSchema.properties ?? {}).sort()).toEqual(["node_id", "path", "run_id"]);
  });
});
