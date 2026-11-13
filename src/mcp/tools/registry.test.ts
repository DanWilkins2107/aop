import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_YAML } from "../../../test/server/helpers.js";
import { HUMAN_COMMANDS } from "../../cli/commands/registry.js";
import { aopHome } from "../../server/paths.js";
import { closeRun, runningRuns } from "../../server/runs.js";
import type { ApplyResult, ImprovementView, ProposalView } from "../../shared/api.js";
import { mcpHarness, resultText, type McpHarness } from "../shared/mcpHarness.helpers.js";
import { TOOLS } from "./registry.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const MCP = join(ROOT, "src", "mcp");

/** The source files below `src/mcp`, tests and their helpers aside, as paths from it with `/`. */
const sourceFiles = () =>
  (readdirSync(MCP, { recursive: true }) as string[])
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.ts$/.test(file) && !/\.(test|helpers)\.ts$/.test(file));

/** Every tool an agent is designed to use. The server offers these and nothing else, though not all exist yet. */
const AGENT_TOOLS = [
  "context",
  "next",
  "ask",
  "fail",
  "message",
  "link",
  "search",
  "node_create",
  "node_edit",
  "edge_add",
  "edge_remove",
  "split_start",
  "split_finish",
  "propose",
  "withdraw_proposal",
  "proposals",
];

describe("the MCP tools", () => {
  it("have unique snake_case names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("are each one file or folder in `tools/`, named as the tool, and nothing else is there", () => {
    const entries = sourceFiles()
      .filter((file) => file.startsWith("tools/") && file !== "tools/registry.ts")
      .map((file) => file.split("/")[1]!.replace(/\.ts$/, ""));
    expect([...new Set(entries)].sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("are each one of the agent tools", () => {
    for (const { name } of TOOLS) expect(AGENT_TOOLS, `${name} isn't an agent tool`).toContain(name);
  });

  it("never share a name with a human command", () => {
    const human = Object.keys(HUMAN_COMMANDS).map((command) => command.replaceAll(" ", "_"));
    for (const name of AGENT_TOOLS) expect(human, `${name} is a human command`).not.toContain(name);
  });
});

/** Improvements switched on, as in `test/server/improvements.test.ts`. */
const IMPROVEMENTS = {
  "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\nimprovements_path: ./skills\n`,
  "improvement_stages.yaml": readFileSync(join(ROOT, "defaults", "improvement_stages.yaml"), "utf8"),
  "prompts/draft_change.md": "Draft it.",
  "prompts/raise_pr.md": "Raise it.",
  "skills/write-tests/SKILL.md": "Old skill.\n",
};

const skills = () => join(aopHome(), "skills");
const skill = () => join(skills(), "write-tests", "SKILL.md");
const extra = () => join(skills(), "extra", "SKILL.md");

const proposals = async (m: McpHarness, id: string) => (await m.call<ProposalView[]>("GET", `/api/improvements/${id}/proposals`)).body;

/** A new run on the node, as if AOP had launched another agent there, once any earlier one has ended. */
async function freshRun(m: McpHarness, id: string): Promise<string> {
  for (const run of runningRuns(m.db).filter((r) => r.node_id === id)) closeRun(m.db, run, "reported", 0);
  m.db.prepare("UPDATE nodes SET claimed_by = NULL WHERE id = ?").run(id);
  return m.run(id);
}

/** An improvement an agent drafted through the tools, and handed to a human at review_change. */
async function inReview(m: McpHarness): Promise<{ id: string; run_id: string }> {
  const { node } = (await m.call<ImprovementView>("POST", "/api/improvements", { body: "x" })).body;
  const run_id = await freshRun(m, node.id);
  await m.text("propose", { node_id: node.id, run_id, path: skill(), content: "Reviewed.\n" });
  await m.text("next", { node_id: node.id, run_id, outcome: "drafted" });
  expect((await m.node(node.id)).stage).toBe("review_change");
  return { id: node.id, run_id };
}

/** A tool call that may be refused, or not exist at all. */
const attempt = (m: McpHarness, name: string, args: Record<string, unknown>) =>
  m.tool(name, args).then(
    (result) => result.isError === true,
    () => true,
  );

/** Every write tool an agent could try on the improvement, each of which must leave the real files alone. */
async function tryEverything(m: McpHarness, id: string, run_id: string): Promise<void> {
  await attempt(m, "propose", { node_id: id, run_id, path: skill(), content: "Swapped in.\n" });
  await attempt(m, "propose", { node_id: id, run_id, path: extra(), content: "Never reviewed.\n" });
  await attempt(m, "withdraw_proposal", { node_id: id, run_id, path: skill() });
  await attempt(m, "apply", { node_id: id, run_id });
  await attempt(m, "apply", { node_id: id, run_id, into: aopHome() });
  await attempt(m, "next", { node_id: id, run_id, outcome: "save_locally" });
}

const realFiles = () => [readFileSync(skill(), "utf8"), readdirSync(skills()).sort()];

describe("saving an improvement, as seen from the MCP tools", () => {
  it("offers no tool that writes proposals to real files", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    expect((await m.tools()).map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(TOOLS.map((t) => t.name)).not.toContain("apply");
    const { id, run_id } = await inReview(m);
    expect(await attempt(m, "apply", { node_id: id, run_id })).toBe(true);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
  });

  it("has no tool that calls the route which writes them", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(join(MCP, file), "utf8");
      expect(source, file).not.toMatch(/["'`]apply["'`]|\/apply\b|applyProposals/);
    }
  });

  it("refuses an agent's propose and withdraw_proposal once the human is reviewing", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    const { id } = await inReview(m);
    const before = await proposals(m, id);
    // The run that drafted it, and a new one, as a process left over or started since would be.
    for (const run_id of [await freshRun(m, id), await m.run()]) {
      for (const [name, args] of [
        ["propose", { path: skill(), content: "Swapped in.\n" }],
        ["propose", { path: extra(), content: "Never reviewed.\n" }],
        ["withdraw_proposal", { path: skill() }],
      ] as const) {
        const result = await m.tool(name, { node_id: id, run_id, ...args });
        expect(result.isError, `${name} ${args.path}`).toBe(true);
      }
    }
    const refusal = await m.tool("propose", { node_id: id, run_id: await freshRun(m, id), path: skill(), content: "Swapped in.\n" });
    expect(resultText(refusal)).toMatch(/human turn, so an agent can't change the proposals/);
    expect(await proposals(m, id)).toEqual(before);
  });

  it("writes exactly what the human reviewed, whatever an agent tried in between", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    const { id, run_id } = await inReview(m);
    const shown = await proposals(m, id);
    await tryEverything(m, id, run_id);
    await tryEverything(m, id, await freshRun(m, id));
    expect(realFiles()).toEqual(["Old skill.\n", ["write-tests"]]);

    const saved = await m.call<ApplyResult>("POST", `/api/improvements/${id}/apply`, {
      reviewed: shown.map(({ path, revision }) => ({ path, revision })),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.written).toEqual([skill()]);
    expect(realFiles()).toEqual(["Reviewed.\n", ["write-tests"]]);
    expect((await m.node(id)).stage).toBe("done");
  });

  it("writes no real file through any tool at any stage, including raise_pr", async () => {
    const m = await mcpHarness(IMPROVEMENTS);
    mkdirSync(join(skills(), ".git"));
    const { node } = (await m.call<ImprovementView>("POST", "/api/improvements", { body: "x" })).body;
    const files = () => [readFileSync(skill(), "utf8"), readdirSync(skills()).sort()];

    // draft_change, the agent's own stage.
    await tryEverything(m, node.id, await freshRun(m, node.id));
    expect(files()).toEqual(["Old skill.\n", [".git", "write-tests"]]);

    const run_id = await freshRun(m, node.id);
    await m.text("propose", { node_id: node.id, run_id, path: skill(), content: "Reviewed.\n" });
    await m.text("next", { node_id: node.id, run_id, outcome: "drafted" });
    await tryEverything(m, node.id, await freshRun(m, node.id));
    expect(files()).toEqual(["Old skill.\n", [".git", "write-tests"]]);

    expect((await m.post(node.id, "next", { outcome: "raise_pr", actor: "human" })).status).toBe(200);
    await tryEverything(m, node.id, await freshRun(m, node.id));
    expect(files()).toEqual(["Old skill.\n", [".git", "write-tests"]]);

    // Finished, by the agent's own `done`.
    await m.tool("next", { node_id: node.id, run_id: await freshRun(m, node.id), outcome: "done" });
    await tryEverything(m, node.id, await freshRun(m, node.id));
    expect(files()).toEqual(["Old skill.\n", [".git", "write-tests"]]);
  });
});
