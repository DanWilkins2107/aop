import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../../src/server/api.js";
import { openDb, type Db } from "../../src/server/db.js";
import type { NodeView } from "../../src/server/nodes.js";
import { aopHome } from "../../src/server/paths.js";
import { registerProject } from "../../src/server/projects.js";

/** The process from specs/stages.md, plus a stage reused by two types. */
export const STAGES_YAML = `
stages:
  assess:         { turn: agent, color: "#5c7cfa", prompt: ./prompts/assess.md }
  split_proposed: { turn: human, color: "#ffc107" }
  split_approved: { turn: agent, color: "#4263eb", prompt: ./prompts/split_approved.md }
  write_spec:  { turn: agent, color: "#22b8cf", prompt: ./prompts/write_spec.md }
  spec_review: { turn: human, color: "#cddc39" }
  implement:   { turn: agent, color: "#12b886", prompt: ./prompts/implement.md }
  pr_review:   { turn: human, color: "#9775fa" }

types:
  triage:
    start: assess
    stages:
      assess:         { next: { ready: dev, split: split_proposed, reject: invalidated } }
      split_proposed: { next: { approve: split_approved, reject: assess } }
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
agent_command: claude -p "{{prompt}}"
stages: ./stages.yaml
max_agents: 3
`;

export const PROMPTS = ["assess", "split_approved", "write_spec", "implement"];

/** Writes files, given paths relative to the root. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function makeRepo(overrides: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(aopHome(), "repo-"));
  writeFiles(repo, {
    ".aop/config.yaml": CONFIG_YAML,
    ".aop/stages.yaml": STAGES_YAML,
    ...Object.fromEntries(PROMPTS.map((p) => [`.aop/prompts/${p}.md`, `Do ${p}.`])),
    ...overrides,
  });
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

/** A fresh database and repo inside the temp AOP_HOME, driven through the real Hono app. */
export function harness(): Harness {
  const home = mkdtempSync(join(aopHome(), "db-"));
  const db = openDb(join(home, "aop.db"));
  const repo = makeRepo();
  const { project } = registerProject(db, repo);
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
      writeFiles(repo, { ".aop/stages.yaml": yaml });
    },
    close() {
      db.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
