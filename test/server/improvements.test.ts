import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api.js";
import { ChangeFeed, type ChangeNotice } from "../../src/server/changes.js";
import { loadConfig } from "../../src/server/config.js";
import { nodeContext } from "../../src/server/context.js";
import { aopHome } from "../../src/server/paths.js";
import { describeProcess } from "../../src/server/processView.js";
import { IMPROVEMENTS_PROJECT_ID, nodeStartPath } from "../../src/server/projects.js";
import type { EventView } from "../../src/shared/events/types.js";
import type { ApiErrorBody } from "../../src/shared/http/types.js";
import type { ApplyResult, ImprovementDetail, ImprovementsList, ImprovementView, ProposalView } from "../../src/shared/improvements/types.js";
import type { MessageRow } from "../../src/shared/nodes/types.js";
import type { ProjectRow } from "../../src/shared/projects/types.js";
import { CONFIG_YAML, harness, writeFiles, type Harness } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");
const defaultFile = (path: string) => readFileSync(join(ROOT, "defaults", path), "utf8");

const ON = {
  "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\nimprovements_path: ./skills\n`,
  "improvement_stages.yaml": defaultFile("improvement_stages.yaml"),
  "prompts/draft_change.md": "Draft it.",
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

const listed = async (id: string) => (await h.call<ProposalView[]>("GET", `/api/improvements/${id}/proposals`)).body;
const reviewedOf = (proposals: ProposalView[]) => proposals.map(({ path, revision }) => ({ path, revision }));

/** A human's Save locally, sending back the proposals their page shows, as the web app does. */
const save = async (id: string, extra: Record<string, unknown> = {}) =>
  h.call<ApplyResult>("POST", `/api/improvements/${id}/apply`, { reviewed: reviewedOf(await listed(id)), ...extra });

/** The agent finishes its draft, which hands the improvement to a human at review_change. */
async function toReview(id: string): Promise<void> {
  const res = await h.post(id, "next", { outcome: "drafted", actor: "agent" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.stage).toBe("review_change");
}

const eventsOf = async (id: string) => (await h.call<EventView[]>("GET", `/api/nodes/${id}/events`)).body;

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
    expect(outcomes).toEqual(["redraft"]);
    expect((await h.post(improvement.node.id, "next", { outcome: "raise_pr" })).status).toBe(409);

    mkdirSync(join(skills(), ".git"));
    const withGit = (await h.node(improvement.node.id)).available_outcomes.map((o) => o.outcome);
    expect(withGit).toEqual(["raise_pr", "redraft"]);
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
    expect(context).toContain("the `next` tool with outcome `drafted`");
  });

  it("tells the agent where each proposal is in the repo, for a PR's worktree", async () => {
    h = harness(ON);
    mkdirSync(join(skills(), ".git"));
    const { node } = await capture({ body: "x" });
    const prompt = join(aopHome(), "prompts", "implement.md");
    await propose(node.id, skill(), "New.\n");
    await propose(node.id, prompt, "Prompt.\n");
    const context = nodeContext(h.db, node.id);
    expect(context).toContain(`That folder is in the git repo ${skills()}.`);
    expect(context).toContain(`- ${skill()} (changes the file, last by agent; in the repo at write-tests/SKILL.md)`);
    expect(context).toContain(`- ${prompt} (changes the file, last by agent; outside the repo)`);
  });

  it("says on the process page when the pipeline still sends improvements to an agent to be saved", () => {
    h = harness(ON);
    expect(describeProcess().improvement_notes).toEqual([]);
    const old = defaultFile("improvement_stages.yaml")
      .replace("raise_pr:      { turn: agent,", "save_locally:  { turn: agent, color: \"#12b886\", prompt: ./prompts/raise_pr.md }\n  raise_pr:      { turn: agent,")
      .replace("redraft: draft_change } }", "save_locally: save_locally, redraft: draft_change } }\n      save_locally:  { next: { done: done } }");
    writeFiles(aopHome(), { "improvement_stages.yaml": old });
    const view = describeProcess();
    expect(view.problems).toEqual([]);
    expect(view.improvement_notes).toHaveLength(1);
    expect(view.improvement_notes[0]).toMatch(/still has the agent stage "save_locally"/);
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
      "skills/prompts/awaiting_agent_clarification.md": "d",
      "skills/prompts/awaiting_agent_summary.md": "e",
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

    expect((await save(node.id)).status).toBe(200);
    expect((await propose(node.id, skill(), "late", "human")).status).toBe(409);
  });

  it.runIf(process.platform === "win32")("treat a new file's path in another case as the same file on Windows", async () => {
    const { node } = await capture({ body: "x" });
    const typed = join(skills(), "new", "NOTES.md");
    await propose(node.id, typed, "First.\n");
    expect((await propose(node.id, join(skills(), "New", "notes.md"), "Second.\n")).body.path).toBe(typed);
    const listed = (await h.call<ProposalView[]>("GET", `/api/improvements/${node.id}/proposals`)).body;
    expect(listed.map((p) => [p.path, p.proposed])).toEqual([[typed, "Second.\n"]]);

    const res = await h.call("DELETE", `/api/improvements/${node.id}/proposals`, { path: join(skills(), "NEW", "Notes.md"), actor: "agent" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await h.call<ProposalView[]>("GET", `/api/improvements/${node.id}/proposals`)).body).toEqual([]);
  });

  it("belong only to improvements", async () => {
    const work = await h.create("dev");
    expect((await propose(work.id, skill(), "x")).status).toBe(409);
    expect((await h.call("GET", `/api/improvements/${work.id}/proposals`)).status).toBe(404);
  });
});

describe("saving locally", () => {
  beforeEach(() => {
    h = harness(ON);
  });

  it("writes the reviewed proposals to their real files and finishes the improvement, in one human action", async () => {
    const { node } = await capture({ body: "x" });
    const fresh = join(skills(), "deep", "new", "SKILL.md");
    await propose(node.id, skill(), "New.\n");
    await propose(node.id, fresh, "Fresh.\n");
    await toReview(node.id);
    // The human's own edit at review is part of what they save.
    expect((await propose(node.id, skill(), "Reviewed.\n", "human")).status).toBe(200);

    const res = await save(node.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect([...res.body.written].sort()).toEqual([fresh, skill()].sort());
    expect(readFileSync(skill(), "utf8")).toBe("Reviewed.\n");
    expect(readFileSync(fresh, "utf8")).toBe("Fresh.\n");
    expect(await h.node(node.id)).toMatchObject({ stage: "done", type: "improvement" });

    const events = await eventsOf(node.id);
    const applied = events.find((e) => e.kind === "proposals_applied");
    expect(applied).toMatchObject({ actor: "human" });
    expect([...(applied?.data as { written: string[] }).written].sort()).toEqual([fresh, skill()].sort());
    expect(events.at(-1)).toMatchObject({
      kind: "stage_changed",
      actor: "human",
      data: { via: "save_locally", from_stage: "review_change", to_stage: "done" },
    });
    // No agent stage came between the review and the write.
    expect(events.filter((e) => e.kind === "stage_changed").map((e) => (e.data as { to_stage: string }).to_stage)).toEqual([
      "review_change",
      "done",
    ]);
    // Saving keeps the proposals, and can't be done twice.
    expect((await listed(node.id)).map((p) => p.display_path)).toEqual(["deep/new/SKILL.md", "write-tests/SKILL.md"]);
    expect((await save(node.id)).status).toBe(409);
  });

  it("is refused at an agent stage, for an agent, and for a node that isn't an improvement, writing nothing", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    // draft_change is the agent's.
    expect((await save(node.id)).status).toBe(409);
    await toReview(node.id);
    expect((await save(node.id, { actor: "agent" })).status).toBe(409);
    expect((await save(node.id, { actor: "system" })).status).toBe(409);

    mkdirSync(join(skills(), ".git"));
    expect((await h.post(node.id, "next", { outcome: "raise_pr", actor: "human" })).status).toBe(200);
    expect((await save(node.id)).status).toBe(409);

    const work = await h.create("dev");
    expect((await h.call("POST", `/api/improvements/${work.id}/apply`, { reviewed: [] })).status).toBe(409);

    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
    expect((await h.node(node.id)).stage).toBe("raise_pr");
    expect((await eventsOf(node.id)).map((e) => e.kind)).not.toContain("proposals_applied");
  });

  it("is refused where the human stage is a built-in one, such as a question the agent asked", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "Half done.\n");
    expect((await h.post(node.id, "ask", { question: "Which skill?" })).status).toBe(200);
    expect((await h.node(node.id)).turn).toBe("human");
    expect((await save(node.id)).status).toBe(409);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
  });

  it("no longer accepts into, or a body that doesn't say what was reviewed", async () => {
    mkdirSync(join(skills(), ".git"));
    const worktree = mkdtempSync(join(aopHome(), "worktree-"));
    mkdirSync(join(worktree, ".git"));
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    await toReview(node.id);

    expect((await save(node.id, { into: worktree })).status).toBe(400);
    expect((await h.call("POST", `/api/improvements/${node.id}/apply`, { into: worktree })).status).toBe(400);
    expect((await h.call("POST", `/api/improvements/${node.id}/apply`, {})).status).toBe(400);
    // Nor at raise_pr, where it used to export.
    expect((await h.post(node.id, "next", { outcome: "raise_pr", actor: "human" })).status).toBe(200);
    expect((await save(node.id, { into: worktree })).status).toBe(400);

    expect(readdirSync(worktree)).toEqual([".git"]);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
  });

  it("refuses when the proposals aren't the ones the human was shown, writing nothing", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "First draft.\n");
    await toReview(node.id);
    const shown = reviewedOf(await listed(node.id));

    // Redrafted behind an open page: different contents, and one more file.
    await h.post(node.id, "next", { outcome: "redraft", actor: "human" });
    await propose(node.id, skill(), "Second draft.\n");
    await toReview(node.id);
    const stale = await h.call("POST", `/api/improvements/${node.id}/apply`, { reviewed: shown });
    expect(stale.status).toBe(409);
    expect((stale.body as unknown as ApiErrorBody).error.message).toMatch(/changed since they were shown/);

    await h.post(node.id, "next", { outcome: "redraft", actor: "human" });
    await propose(node.id, skill(), "First draft.\n");
    await propose(node.id, join(skills(), "extra", "SKILL.md"), "Extra.\n");
    await toReview(node.id);
    expect((await h.call("POST", `/api/improvements/${node.id}/apply`, { reviewed: shown })).status).toBe(409);
    expect((await h.call("POST", `/api/improvements/${node.id}/apply`, { reviewed: [] })).status).toBe(409);

    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
    expect(existsSync(join(skills(), "extra"))).toBe(false);
    expect((await h.node(node.id)).stage).toBe("review_change");
  });

  it("refuses a proposal whose path stopped being allowed, writing nothing", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    const prompt = join(aopHome(), "prompts", "implement.md");
    await propose(node.id, prompt, "Prompt.\n");
    await toReview(node.id);
    // The prompt is no longer one, because the process stopped using it.
    writeFiles(aopHome(), { "stages.yaml": readFileSync(join(aopHome(), "stages.yaml"), "utf8").replace("./prompts/implement.md", "./prompts/write_spec.md") });
    expect((await save(node.id)).status).toBe(400);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
    expect((await h.node(node.id)).stage).toBe("review_change");
  });

  it("leaves every real file as it was, and the improvement in review, when one of them can't be written", async () => {
    // A file where the second proposal needs a folder, so only writing it can find the problem.
    writeFiles(aopHome(), { "skills/zz": "In the way.\n" });
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    await propose(node.id, join(skills(), "zz", "SKILL.md"), "Blocked.\n");
    await toReview(node.id);

    const res = await save(node.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(readFileSync(skill(), "utf8")).toBe("Old skill.\n");
    expect(readdirSync(join(skills(), "write-tests"))).toEqual(["SKILL.md"]);
    expect((await h.node(node.id)).stage).toBe("review_change");
    expect((await eventsOf(node.id)).map((e) => e.kind)).not.toContain("proposals_applied");
  });

  it("is how a human saves an improvement left at an agent stage by an older pipeline, after moving it back", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "New.\n");
    mkdirSync(join(skills(), ".git"));
    await toReview(node.id);
    await h.post(node.id, "next", { outcome: "raise_pr", actor: "human" });
    expect((await save(node.id)).status).toBe(409);
    expect((await h.post(node.id, "move", { stage: "review_change" })).status).toBe(200);
    expect((await save(node.id)).status).toBe(200);
    expect(readFileSync(skill(), "utf8")).toBe("New.\n");
  });
});

describe("stale proposals", () => {
  beforeEach(() => {
    h = harness(ON);
  });

  it("refuses to save any file when one changed since it was drafted, naming it, writing nothing and moving nothing", async () => {
    const { node } = await capture({ body: "x" });
    const fresh = join(skills(), "new-skill", "SKILL.md");
    await propose(node.id, skill(), "Proposed.\n");
    await propose(node.id, fresh, "Fresh.\n");
    expect((await listed(node.id)).map((p) => p.stale)).toEqual([false, false]);

    writeFiles(aopHome(), { "skills/write-tests/SKILL.md": "Edited by hand.\n" });
    const proposals = await listed(node.id);
    expect(proposals.map((p) => [p.display_path, p.stale, p.current])).toEqual([
      ["new-skill/SKILL.md", false, null],
      ["write-tests/SKILL.md", true, "Edited by hand.\n"],
    ]);

    await toReview(node.id);
    const res = await save(node.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const error = (res.body as unknown as ApiErrorBody).error;
    expect(error.details).toEqual({ stale: [skill()] });
    expect(error.message).toContain(skill());
    expect(readFileSync(skill(), "utf8")).toBe("Edited by hand.\n");
    expect(existsSync(fresh)).toBe(false);
    expect((await h.node(node.id)).stage).toBe("review_change");
    const events = await eventsOf(node.id);
    expect(events.map((e) => e.kind)).not.toContain("proposals_applied");
    expect(events.at(-1)).toMatchObject({ kind: "stage_changed", data: { to_stage: "review_change" } });
  });

  it("counts a new file as stale once something is written there", async () => {
    const { node } = await capture({ body: "x" });
    const fresh = join(skills(), "new-skill", "SKILL.md");
    await propose(node.id, fresh, "Fresh.\n");
    writeFiles(aopHome(), { "skills/new-skill/SKILL.md": "Got there first.\n" });
    expect((await listed(node.id))[0]?.stale).toBe(true);
    await toReview(node.id);
    expect((await save(node.id)).status).toBe(409);
    expect(readFileSync(fresh, "utf8")).toBe("Got there first.\n");
  });

  it("goes stale when another improvement is saved first", async () => {
    const first = (await capture({ body: "first" })).node;
    const second = (await capture({ body: "second" })).node;
    await propose(first.id, skill(), "First.\n");
    await propose(second.id, skill(), "Second.\n");
    await toReview(first.id);
    expect((await save(first.id)).status).toBe(200);

    await toReview(second.id);
    expect((await save(second.id)).status).toBe(409);
    expect(readFileSync(skill(), "utf8")).toBe("First.\n");
  });

  it("is re-based on the current file when a human saves an edit", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "Proposed.\n");
    await toReview(node.id);
    writeFiles(aopHome(), { "skills/write-tests/SKILL.md": "Edited by hand.\n" });
    expect((await listed(node.id))[0]?.stale).toBe(true);

    const saved = await propose(node.id, skill(), "Edited by hand, then proposed.\n", "human");
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.stale).toBe(false);
    expect((await save(node.id)).status).toBe(200);
    expect(readFileSync(skill(), "utf8")).toBe("Edited by hand, then proposed.\n");
  });

  it("never blocks a proposal saved before bases were recorded", async () => {
    const { node } = await capture({ body: "x" });
    await propose(node.id, skill(), "Proposed.\n");
    h.db.prepare("UPDATE proposals SET base = 'unknown'").run();
    writeFiles(aopHome(), { "skills/write-tests/SKILL.md": "Edited by hand.\n" });
    expect((await listed(node.id))[0]?.stale).toBe(false);
    await toReview(node.id);
    expect((await save(node.id)).status).toBe(200);
    expect(readFileSync(skill(), "utf8")).toBe("Proposed.\n");
  });
});

describe("change notices", () => {
  beforeEach(() => {
    h = harness(ON);
  });

  it("name the improvement, and on capture the work node it came from", async () => {
    const message = await sourceMessage();
    const changes = new ChangeFeed();
    const heard: ChangeNotice[] = [];
    changes.subscribe((notice) => heard.push(notice));
    const app = createApp(h.db, { changes });
    const send = async (method: string, path: string, body: unknown) => {
      const res = await app.request(path, { method, headers: { host: "localhost:4317" }, body: JSON.stringify(body) });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      return res.json() as Promise<unknown>;
    };

    const { node } = (await send("POST", "/api/improvements", { body: "x", source_message_id: message.id })) as ImprovementView;
    const captured = heard.at(-1);
    expect([...(captured?.project_ids ?? [])].sort()).toEqual([IMPROVEMENTS_PROJECT_ID, h.projectId].sort());
    expect([...(captured?.node_ids ?? [])].sort()).toEqual([node.id, message.node_id].sort());

    await send("PUT", `/api/improvements/${node.id}/proposals`, { path: skill(), content: "new", actor: "agent" });
    expect(heard.at(-1)).toEqual({ project_ids: [IMPROVEMENTS_PROJECT_ID], node_ids: [node.id] });
    await send("DELETE", `/api/improvements/${node.id}/proposals`, { path: skill(), actor: "agent" });
    expect(heard.at(-1)).toEqual({ project_ids: [IMPROVEMENTS_PROJECT_ID], node_ids: [node.id] });
  });
});
