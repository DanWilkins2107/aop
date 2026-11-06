import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { nodeContext } from "../../src/server/context.js";
import { aopHome } from "../../src/server/paths.js";
import { nodeStartPath } from "../../src/server/projects.js";
import type {
  ApplyResult,
  ImprovementDetail,
  ImprovementsList,
  ImprovementView,
  MessageRow,
  NodeView,
  ProjectRow,
  ProposalView,
} from "../../src/shared/api.js";
import { CONFIG_YAML, harness, writeFiles, type Harness } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");
const defaultFile = (path: string) => readFileSync(join(ROOT, "defaults", path), "utf8");

const ON = {
  "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\nimprovements_path: ./skills\n`,
  "improvement_stages.yaml": defaultFile("improvement_stages.yaml"),
  "prompts/draft_change.md": "Draft it.",
  "prompts/save_locally.md": "Save it.",
  "prompts/raise_pr.md": "Raise it.",
  "skills/write-tests/SKILL.md": "Old skill.\n",
};

let h: Harness;
const skills = () => join(aopHome(), "skills");
const skill = () => join(skills(), "write-tests", "SKILL.md");

async function sourceMessage(text = "Agents keep skipping tests.\nThey should write one per behaviour."): Promise<MessageRow> {
  const node = await h.create("dev");
  return (await h.call<MessageRow>("POST", `/api/nodes/${node.id}/messages`, { body: text, author: "agent" })).body;
}

async function capture(body: Record<string, unknown>): Promise<ImprovementView> {
  const res = await h.call<ImprovementView>("POST", "/api/improvements", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const propose = (id: string, path: string, content: string, actor = "agent") =>
  h.call<ProposalView>("PUT", `/api/improvements/${id}/proposals`, { path, content, actor });

const apply = (id: string, into?: string) =>
  h.call<ApplyResult>("POST", `/api/improvements/${id}/apply`, into === undefined ? {} : { into });

/** Drafted by the agent, then a human picks the outcome. */
async function reviewAndChoose(id: string, outcome: string): Promise<NodeView> {
  expect((await h.post(id, "next", { outcome: "drafted", actor: "agent" })).status).toBe(200);
  const res = await h.post(id, "next", { outcome, actor: "human" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe("capturing", () => {
  beforeEach(() => {
    h = harness(ON);
  });

  it("makes an improvement node from a message, starting the improvement pipeline", async () => {
    const message = await sourceMessage();
    const improvement = await capture({ body: "Make the test skill insist on one behaviour per test.\nMore detail.", source_message_id: message.id });
    expect(improvement.node).toMatchObject({
      kind: "improvement",
      type: "improvement",
      stage: "draft_change",
      turn: "agent",
      title: "Make the test skill insist on one behaviour per test.",
      body: "Make the test skill insist on one behaviour per test.\nMore detail.",
    });
    expect(improvement.source).toMatchObject({
      node_id: message.node_id,
      message_id: message.id,
      project_id: h.projectId,
      excerpt: message.body,
      node_title: "A dev node",
    });
    const sourceEvents = (await h.call<{ kind: string }[]>("GET", `/api/nodes/${message.node_id}/events`)).body;
    expect(sourceEvents.map((e) => e.kind)).toContain("improvement_captured");
  });

  it("needs no source, and cuts a long first line to a title", async () => {
    const improvement = await capture({ body: "x".repeat(300) });
    expect(improvement.source).toBeNull();
    expect([...improvement.node.title]).toHaveLength(80);
  });

  it("refuses blank text, an unknown message, and a message on another improvement", async () => {
    expect((await h.call("POST", "/api/improvements", { body: "  " })).status).toBe(400);
    expect((await h.call("POST", "/api/improvements", { body: "x", source_message_id: "nope" })).status).toBe(404);
    const improvement = await capture({ body: "First" });
    const onIt = (await h.call<MessageRow>("POST", `/api/nodes/${improvement.node.id}/messages`, { body: "hi" })).body;
    expect((await h.call("POST", "/api/improvements", { body: "x", source_message_id: onIt.id })).status).toBe(409);
  });

  it("keeps improvements out of every project", async () => {
    const improvement = await capture({ body: "Somewhere" });
    const projects = (await h.call<ProjectRow[]>("GET", "/api/projects")).body;
    expect(projects.map((p) => p.id)).toEqual([h.projectId]);
    expect((await h.call("GET", `/api/projects/${improvement.node.project_id}/nodes`)).status).toBe(404);
    expect((await h.call("DELETE", `/api/projects/${improvement.node.project_id}`)).status).toBe(404);
    const work = await h.create("dev");
    const edge = await h.call("POST", `/api/nodes/${work.id}/edges`, { target_id: improvement.node.id, kind: "blocks" });
    expect(edge.status).toBe(409);
  });

  it("keeps the source's text when its project is deleted", async () => {
    const message = await sourceMessage("Remember this.");
    const improvement = await capture({ body: "Fix it", source_message_id: message.id });
    expect((await h.call("DELETE", `/api/projects/${h.projectId}`)).status).toBe(200);
    const detail = (await h.call<ImprovementDetail>("GET", `/api/improvements/${improvement.node.id}`)).body;
    expect(detail.source).toEqual({
      node_id: null,
      message_id: null,
      project_id: null,
      excerpt: "Remember this.",
      node_title: "A dev node",
      project_name: null,
    });
  });
});

describe("listing", () => {
  beforeEach(() => {
    h = harness(ON);
  });

  it("lists every improvement, newest first", async () => {
    const first = await capture({ body: "First" });
    const second = await capture({ body: "Second", source_message_id: (await sourceMessage()).id });
    const list = (await h.call<ImprovementsList>("GET", "/api/improvements")).body;
    expect(list.enabled).toBe(true);
    expect(list.improvements.map((i) => i.node.id)).toEqual([second.node.id, first.node.id]);
    expect(list.improvements[0]?.source?.node_title).toBe("A dev node");
  });

  it("is off, and says how to turn it on, without improvement_stages", async () => {
    writeFiles(aopHome(), { "config.yaml": CONFIG_YAML });
    const list = (await h.call<ImprovementsList>("GET", "/api/improvements")).body;
    expect(list).toMatchObject({ enabled: false, improvements: [] });
    expect(list.note).toContain("improvement_stages");
    expect((await h.call("POST", "/api/improvements", { body: "x" })).status).toBe(409);
  });
});

describe("the improvement pipeline", () => {
  it("loads from config.yaml, separately from stages.yaml", () => {
    h = harness(ON);
    const config = loadConfig();
    expect([...config.improvementGraph!.types.keys()]).toEqual(["improvement"]);
    expect([...config.graph.types.keys()]).not.toContain("improvement");
    expect(config.improvementsDir).toBe(skills());
  });

  it("reports problems in the improvement file by name", () => {
    h = harness({ ...ON, "improvement_stages.yaml": "start: nowhere\nstages: {}\ntypes: {}\n" });
    expect(() => loadConfig()).toThrow(/improvement_stages\.yaml: start "nowhere" is not a type/);
  });

  it("refuses an improvements_path that is AOP_HOME", () => {
    h = harness({ ...ON, "config.yaml": `${CONFIG_YAML}improvements_path: .\n` });
    expect(() => loadConfig()).toThrow(/improvements_path/);
  });

  it("hides and refuses Raise PR unless the improvements folder is in a git repo", async () => {
    h = harness(ON);
    const improvement = await capture({ body: "x" });
    await h.post(improvement.node.id, "next", { outcome: "drafted", actor: "agent" });
    const outcomes = (await h.node(improvement.node.id)).available_outcomes.map((o) => o.outcome);
    expect(outcomes).toEqual(["save_locally", "redraft"]);
    expect((await h.post(improvement.node.id, "next", { outcome: "raise_pr" })).status).toBe(409);

    mkdirSync(join(skills(), ".git"));
    const withGit = (await h.node(improvement.node.id)).available_outcomes.map((o) => o.outcome);
    expect(withGit).toEqual(["raise_pr", "save_locally", "redraft"]);
  });

  it("starts its agents in the improvements folder, and says what they may change", async () => {
    h = harness(ON);
    const message = await sourceMessage("Too many tests.");
    const improvement = await capture({ body: "x", source_message_id: message.id });
    expect(nodeStartPath(h.db, improvement.node, loadConfig())).toBe(skills());
    const context = nodeContext(h.db, improvement.node.id);
    expect(context).toContain("## Source message");
    expect(context).toContain("Too many tests.");
    expect(context).toContain(`Files inside ${skills()}`);
    expect(context).toContain(join(aopHome(), "prompts", "implement.md"));
    expect(context).toContain("`aop next drafted`");
  });
});

describe("proposals", () => {
  beforeEach(() => {
    h = harness(ON);
  });

  it("are stored in AOP, and diffed against the untouched real file", async () => {
    const { node } = await capture({ body: "x" });
    const res = await propose(node.id, skill(), "New skill.\n");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ display_path: "write-tests/SKILL.md", proposed: "New skill.\n", current: "Old skill.\n" });
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");

    const fresh = join(skills(), "new-skill", "SKILL.md");
    await propose(node.id, fresh, "Brand new.\n");
    expect(existsSync(fresh)).toBe(false);
    const list = (await h.call<ProposalView[]>("GET", `/api/improvements/${node.id}/proposals`)).body;
    expect(list.map((p) => [p.display_path, p.current])).toEqual([
      ["new-skill/SKILL.md", null],
      ["write-tests/SKILL.md", "Old skill.\n"],
    ]);

    // Saving again replaces the proposal, and withdrawing drops it.
    await propose(node.id, skill(), "Newer.\n");
    expect((await h.call("DELETE", `/api/improvements/${node.id}/proposals`, { path: fresh, actor: "agent" })).status).toBe(200);
    const after = (await h.call<ProposalView[]>("GET", `/api/improvements/${node.id}/proposals`)).body;
    expect(after.map((p) => p.proposed)).toEqual(["Newer.\n"]);
  });

  it("can change a stage prompt", async () => {
    const { node } = await capture({ body: "x" });
    const prompt = join(aopHome(), "prompts", "implement.md");
    const res = await propose(node.id, prompt, "Do it better.");
    expect(res.status).toBe(200);
    expect(res.body.display_path).toBe(prompt);
  });

  it("refuses paths outside improvements_path, and AOP's own files", async () => {
    const { node } = await capture({ body: "x" });
    const outside = mkdtempSync(join(aopHome(), "outside-"));
    for (const path of [
      join(outside, "SKILL.md"),
      join(skills(), "..", "config.yaml"),
      join(aopHome(), "config.yaml"),
      join(aopHome(), "stages.yaml"),
      join(aopHome(), "improvement_stages.yaml"),
      join(aopHome(), "aop.db"),
      skills(),
      join(skills(), "write-tests"),
      "write-tests/SKILL.md",
    ]) {
      const res = await propose(node.id, path, "evil");
      expect(res.status, path).toBe(400);
      expect((res.body as unknown as { error: { code: string } }).error.code, path).toBe("path_not_allowed");
    }
    expect((await h.call<ProposalView[]>("GET", `/api/improvements/${node.id}/proposals`)).body).toEqual([]);
  });

  it("refuses config.yaml and stages files even inside improvements_path", async () => {
    h.close();
    h = harness({
      ...ON,
      "config.yaml": `${CONFIG_YAML.replace("stages: ./stages.yaml", "stages: ./skills/stages.yaml")}improvement_stages: ./improvement_stages.yaml\n`,
      "skills/stages.yaml": defaultFile("stages.yaml"),
      "skills/prompts/awaiting_agent_breakdown.md": "a",
      "skills/prompts/split_approved.md": "b",
      "skills/prompts/implement.md": "c",
      "skills/prompts/generate_report.md": "d",
    });
    const { node } = await capture({ body: "x" });
    expect((await propose(node.id, join(skills(), "stages.yaml"), "evil")).status).toBe(400);
  });

  it("are the agent's on agent stages and the human's on human stages, and close when done", async () => {
    const { node } = await capture({ body: "x" });
    await h.post(node.id, "next", { outcome: "drafted", actor: "agent" });
    expect((await propose(node.id, skill(), "agent edit", "agent")).status).toBe(409);
    const human = await propose(node.id, skill(), "human edit", "human");
    expect(human.status).toBe(200);
    expect(human.body.updated_by).toBe("human");

    await h.post(node.id, "next", { outcome: "save_locally" });
    await h.post(node.id, "next", { outcome: "done", actor: "agent" });
    expect((await propose(node.id, skill(), "late", "human")).status).toBe(409);
  });

  it("belong only to improvements", async () => {
    const work = await h.create("dev");
    expect((await propose(work.id, skill(), "x")).status).toBe(409);
    expect((await h.call("GET", `/api/improvements/${work.id}/proposals`)).status).toBe(404);
  });
});

describe("applying", () => {
  beforeEach(() => {
    h = harness(ON);
  });

  it("writes nothing before save_locally", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    expect((await apply(node.id)).status).toBe(409);
    await h.post(node.id, "next", { outcome: "drafted", actor: "agent" });
    expect((await apply(node.id)).status).toBe(409);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
  });

  it("writes every proposal to its real file at save_locally, creating folders", async () => {
    const { node } = await capture({ body: "x" });
    const fresh = join(skills(), "deep", "new", "SKILL.md");
    await propose(node.id, skill(), "New.\n");
    await propose(node.id, fresh, "Fresh.\n");
    await reviewAndChoose(node.id, "save_locally");

    const res = await apply(node.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.written.sort()).toEqual([fresh, skill()].sort());
    expect(readFileSync(skill(), "utf8")).toBe("New.\n");
    expect(readFileSync(fresh, "utf8")).toBe("Fresh.\n");
    const events = (await h.call<{ kind: string }[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.map((e) => e.kind)).toContain("proposals_applied");
  });

  it("refuses a proposal whose path stopped being allowed, writing nothing", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    const prompt = join(aopHome(), "prompts", "implement.md");
    await propose(node.id, prompt, "Prompt.\n");
    await reviewAndChoose(node.id, "save_locally");
    // The prompt is no longer one, because the process stopped using it.
    writeFiles(aopHome(), { "stages.yaml": readFileSync(join(aopHome(), "stages.yaml"), "utf8").replace("./prompts/implement.md", "./prompts/write_spec.md") });
    expect((await apply(node.id)).status).toBe(400);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
  });

  it("exports into another checkout at raise_pr, skipping files outside the repo", async () => {
    mkdirSync(join(skills(), ".git"));
    const worktree = mkdtempSync(join(aopHome(), "worktree-"));
    mkdirSync(join(worktree, ".git"));
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    const prompt = join(aopHome(), "prompts", "implement.md");
    await propose(node.id, prompt, "Prompt.\n");
    await reviewAndChoose(node.id, "raise_pr");

    expect((await apply(node.id, skills())).status).toBe(409);
    expect((await apply(node.id, mkdtempSync(join(aopHome(), "plain-")))).status).toBe(409);
    const res = await apply(node.id, worktree);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ written: [join(worktree, "write-tests", "SKILL.md")], skipped: [prompt] });
    expect(readFileSync(join(worktree, "write-tests", "SKILL.md"), "utf8")).toBe("New.\n");
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
    // The real files are only for save_locally.
    expect((await apply(node.id)).status).toBe(409);
  });

  it("refuses to follow a link in the other checkout out of it, writing nothing", async () => {
    mkdirSync(join(skills(), ".git"));
    const worktree = mkdtempSync(join(aopHome(), "worktree-"));
    mkdirSync(join(worktree, ".git"));
    const outside = mkdtempSync(join(aopHome(), "outside-"));
    // A junction needs no special rights on Windows, and is a plain symlink elsewhere.
    symlinkSync(outside, join(worktree, "write-tests"), "junction");
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    await reviewAndChoose(node.id, "raise_pr");

    const res = await apply(node.id, worktree);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
  });
});
