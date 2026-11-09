import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { buildPrompt } from "../../src/server/context.js";
import { ConfigError } from "../../src/server/errors.js";
import { allowedTarget } from "../../src/server/improvements.js";
import { getNodeRow } from "../../src/server/nodes.js";
import { aopHome } from "../../src/server/paths.js";
import { addProject } from "../../src/server/projects.js";
import type { ConfigView, NodeView, ProcessView, StagesView } from "../../src/shared/api.js";
import { CONFIG_YAML, harness, type Harness, writeFiles } from "./helpers.js";

/** A project's own process, in a folder of its own. */
const OWN_STAGES = `
start: chore
stages:
  tidy:  { turn: agent, prompt: ./prompts/tidy.md }
  check: { turn: human }
types:
  chore:
    start: tidy
    stages:
      tidy:  { next: { tidied: check } }
      check: { next: { ok: done } }
`;

let h: Harness;

function useOwnProcess(projectId: string, stages = OWN_STAGES): void {
  writeFiles(aopHome(), {
    "config.yaml": `${CONFIG_YAML}project_stages:\n  ${projectId}: ./own/stages.yaml\n`,
    "own/stages.yaml": stages,
    "own/prompts/tidy.md": "Tidy up.",
  });
}

function problems(): string[] {
  try {
    loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

beforeEach(() => {
  h = harness();
  useOwnProcess(h.projectId);
});

describe("project_stages", () => {
  it("loads each project's process, with prompts relative to its own file", () => {
    const own = loadConfig().projectStages.get(h.projectId);
    expect(own?.path).toBe(join(aopHome(), "own", "stages.yaml"));
    expect(own?.graph.start).toBe("chore");
    expect(own?.graph.stages.get("tidy")?.prompt).toBe(join(aopHome(), "own", "prompts", "tidy.md"));
  });

  it("checks each file like stages.yaml, naming the project in every problem", () => {
    useOwnProcess(h.projectId, OWN_STAGES.replace("next: { ok: done }", "next: { ok: nowhere }"));
    const found = problems();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`project_stages.${h.projectId}: `);
    expect(found[0]).toContain('"nowhere"');
  });

  it("reports a missing file, and refuses the improvements project", () => {
    writeFiles(aopHome(), {
      "config.yaml": `${CONFIG_YAML}project_stages:\n  ${h.projectId}: ./missing.yaml\n  improvements: ./own/stages.yaml\n`,
    });
    const found = problems().join("\n");
    expect(found).toContain(`project_stages.${h.projectId}: ${join(aopHome(), "missing.yaml")}: file not found`);
    expect(found).toContain("project_stages.improvements: improvements follow improvement_stages");
  });

  it("serves the project's process from /api/stages?project=, and the shared one without", async () => {
    const own = await h.call<StagesView>("GET", `/api/stages?project=${h.projectId}`);
    expect(own.body.start).toBe("chore");
    expect((await h.call<StagesView>("GET", "/api/stages")).body.start).toBe("triage");
    expect((await h.call("GET", "/api/stages?project=nope")).status).toBe(404);
  });

  it("starts, moves and offers outcomes by the node's own project's process", async () => {
    const node = (await h.call<NodeView>("POST", `/api/projects/${h.projectId}/nodes`, { title: "Tidy" })).body;
    expect(node).toMatchObject({ type: "chore", stage: "tidy", turn: "agent", stage_exists: true });
    expect(node.available_outcomes).toEqual([{ outcome: "tidied", target: "check" }]);
    expect((await h.post(node.id, "next", { outcome: "tidied" })).body.stage).toBe("check");
    expect((await h.call("POST", `/api/projects/${h.projectId}/nodes`, { title: "x", type: "dev" })).status).toBe(400);

    // Another project still follows stages.yaml.
    const other = addProject(h.db, { name: "Other" });
    const shared = (await h.call<NodeView>("POST", `/api/projects/${other.id}/nodes`, { title: "Triage me" })).body;
    expect(shared).toMatchObject({ type: "triage", stage: "awaiting_agent_breakdown" });
  });

  it("leaves a node on a stage its project's process lacks for a human to move", async () => {
    writeFiles(aopHome(), { "config.yaml": CONFIG_YAML });
    const node = await h.create("dev");
    useOwnProcess(h.projectId);
    const view = await h.node(node.id);
    expect(view).toMatchObject({ stage: "write_spec", stage_exists: false, turn: null });
    expect((await h.post(node.id, "next", { outcome: "done" })).status).toBe(409);
    expect((await h.post(node.id, "move", { stage: "tidy" })).body).toMatchObject({ type: "chore", stage: "tidy" });
  });

  it("gives agents the prompt from the project's process", async () => {
    const node = (await h.call<NodeView>("POST", `/api/projects/${h.projectId}/nodes`, { title: "Tidy" })).body;
    expect(buildPrompt(h.db, loadConfig(), getNodeRow(h.db, node.id), "run-1")).toContain("Tidy up.");
  });

  it("shows which projects have their own process on the process and settings pages", async () => {
    const process = (await h.call<ProcessView>("GET", "/api/process")).body;
    expect(process.process?.start).toBe("triage");
    expect(process.project_processes).toEqual([
      expect.objectContaining({ project_id: h.projectId, stages_path: join(aopHome(), "own", "stages.yaml") }),
    ]);
    expect(process.project_processes[0]?.process.start).toBe("chore");
    const config = (await h.call<ConfigView>("GET", "/api/config")).body;
    expect(config.settings?.project_stages).toEqual([
      { project_id: h.projectId, stages: "./own/stages.yaml", stages_path: join(aopHome(), "own", "stages.yaml") },
    ]);
  });

  it("lets improvements change a project's prompts, but never its process file", () => {
    const config = loadConfig();
    expect(allowedTarget(config, join(aopHome(), "own", "prompts", "tidy.md"))).toContain("tidy.md");
    expect(() => allowedTarget(config, join(aopHome(), "own", "stages.yaml"))).toThrow(/AOP's own config/);
  });
});
