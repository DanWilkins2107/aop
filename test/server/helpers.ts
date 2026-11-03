import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../../src/server/api.js";
import { openDb, type Db } from "../../src/server/db.js";
import type { NodeView } from "../../src/server/nodes.js";
import { aopHome } from "../../src/server/paths.js";
import { addProject } from "../../src/server/projects.js";

/** The process from specs/stages.md, plus a stage reused by two types. */
export const STAGES_YAML = `
start: triage

stages:
  awaiting_agent_breakdown:         { turn: agent, color: "#5c7cfa", prompt: ./prompts/awaiting_agent_breakdown.md }
  split_proposed: { turn: human, color: "#ffc107" }
  split_approved: { turn: agent, color: "#4263eb", prompt: ./prompts/split_approved.md }
  write_spec:  { turn: agent, color: "#22b8cf", prompt: ./prompts/write_spec.md }
  spec_review: { turn: human, color: "#cddc39" }
  implement:   { turn: agent, color: "#12b886", prompt: ./prompts/implement.md }
  pr_review:   { turn: human, color: "#9775fa" }

types:
  triage:
    start: awaiting_agent_breakdown
    stages:
      awaiting_agent_breakdown:         { next: { ready: dev, split: split_proposed } }
      split_proposed: { next: { approve: split_approved, reject: awaiting_agent_breakdown } }
      split_approved: { next: { done: broken_down } }
  dev:
    start: write_spec
    stages:
      write_spec:  { next: { done: spec_review } }
      spec_review: { next: { approve: implement, reject: write_spec } }
      implement:   { next: { pr_raised: pr_review } }
      pr_review:   { next: { merged: done, changes: implement } }
  hotfix:
    start: implement
    stages:
      implement:   { next: { fixed: done, to_nightly: nightly } }
  nightly:
    start: scheduled
    stages:
      scheduled:   { next: { fire: triage } }
`;

export const CONFIG_YAML = `
agent_session_command: sandboxed-claude
out_of_sandbox_command: claude
open_from: ~/code
agent_timeout_minutes: 30
stages: ./stages.yaml
`;

export const PROMPTS = ["awaiting_agent_breakdown", "split_approved", "write_spec", "implement"];

/** Writes files, given paths relative to the root. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** A folder set up the way `~/.aop` is. `overrides` can replace or add files by relative path. */
export function makeHome(overrides: Record<string, string> = {}): string {
  const home = mkdtempSync(join(aopHome(), "home-"));
  writeFiles(home, {
    "config.yaml": CONFIG_YAML,
    "stages.yaml": STAGES_YAML,
    ...Object.fromEntries(PROMPTS.map((p) => [`prompts/${p}.md`, `Do ${p}.`])),
    ...overrides,
  });
  return home;
}

/** A project's repo is any folder. */
export function makeRepo(): string {
  const repo = mkdtempSync(join(aopHome(), "repo-"));
  writeFiles(repo, { "README.md": "A repo.\n" });
  return repo;
}

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export interface Harness {
  db: Db;
  repo: string;
  projectId: string;
  call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Res<T>>;
  create(type: string, extra?: Record<string, unknown>): Promise<NodeView>;
  post(nodeId: string, action: string, body?: unknown): Promise<Res<NodeView>>;
  node(nodeId: string): Promise<NodeView>;
  rewriteStages(yaml: string): void;
  close(): void;
}

/** Fresh state, with AOP_HOME pointing at it until `close`, driven through the real Hono app. */
export function harness(): Harness {
  const outerHome = process.env["AOP_HOME"];
  const home = makeHome();
  process.env["AOP_HOME"] = home;
  const db = openDb();
  const repo = makeRepo();
  const project = addProject(db, { repo_path: repo });
  const app = createApp(db);

  const call: Harness["call"] = async <T,>(method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { host: "localhost:4317" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json()) as T };
  };

  const post: Harness["post"] = (nodeId, action, body) =>
    call<NodeView>("POST", `/api/nodes/${nodeId}/${action}`, body ?? {});

  return {
    db,
    repo,
    projectId: project.id,
    call,
    post,
    async create(type, extra = {}) {
      const res = await call<NodeView>("POST", `/api/projects/${project.id}/nodes`, {
        type,
        title: `A ${type} node`,
        ...extra,
      });
      if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async node(nodeId) {
      return (await call<NodeView>("GET", `/api/nodes/${nodeId}`)).body;
    },
    rewriteStages(yaml) {
      writeFiles(home, { "stages.yaml": yaml });
    },
    close() {
      db.close();
      process.env["AOP_HOME"] = outerHome;
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
