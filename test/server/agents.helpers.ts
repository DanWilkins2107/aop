import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, onTestFinished } from "vitest";
import { ChangeFeed } from "../../src/server/changes.js";
import { openDb, type Db } from "../../src/server/db.js";
import { Orchestrator } from "../../src/server/orchestrator.js";
import { aopHome } from "../../src/server/paths.js";
import { isAlive, killTree } from "../../src/server/processes.js";
import { addProject } from "../../src/server/projects.js";
import type { RunRow } from "../../src/server/runs.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import type { NodeView } from "../../src/shared/api.js";
import { makeHome, makeRepo } from "./helpers.js";

export const ROOT = resolve(import.meta.dirname, "../..");
export const FAKE_AGENT = join(ROOT, "test", "fixtures", "fake-agent.mjs");
/** The same fake, under a name AOP reads as Claude Code, so it gets the stream-json flags and writes events. */
export const FAKE_CLAUDE = join(ROOT, "test", "fixtures", "fake-claude.mjs");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

/** Runs the real source through tsx, on any platform, as the `aop` command does after `npm link`. */
export function nodeArgs(script: string): string[] {
  return ["--import", TSX_LOADER, join(ROOT, script)];
}

/** A folder holding an `aop` command for fake agents to find on PATH. */
export function aopShim(): string {
  const folder = mkdtempSync(join(aopHome(), "bin-"));
  const [imp, loader, main] = nodeArgs("src/cli/main.ts");
  writeFileSync(join(folder, "aop.cmd"), `@"${process.execPath}" ${imp} "${loader}" "${main}" %*\r\n`);
  writeFileSync(join(folder, "aop"), `#!/bin/sh\nexec "${process.execPath}" ${imp} "${loader}" "${main}" "$@"\n`, { mode: 0o755 });
  return folder;
}

export const fakeCommand = `"${process.execPath}" "${FAKE_AGENT}"`;
export const fakeClaudeCommand = `"${process.execPath}" "${FAKE_CLAUDE}"`;

export function fakeConfig(extra = "", command = fakeCommand): string {
  return `agent_session_command: ${JSON.stringify(command)}\nagent_timeout_minutes: 5\nstages: ./stages.yaml\n${extra}`;
}

export const directives = (...lines: string[]) => lines.map((line) => `@@${line}`).join("\n");

/**
 * Gives the system time to do something it mustn't, before checking that it didn't. Only for that: wait
 * for something that should happen with `until` or `expect.poll`, which wait no longer than they need.
 */
export const settle = (ms = 1_500) => new Promise((done) => setTimeout(done, ms));

/** Waits for the process ID that a fake agent's `@@pid` or `@@child` writes to a file. */
export function pidIn(file: string): Promise<number> {
  return until(`a process ID in ${file}`, () => {
    try {
      return Number(readFileSync(file, "utf8")) || null;
    } catch {
      return null;
    }
  });
}

export async function until<T>(what: string, check: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

export interface World {
  home: string;
  repo: string;
  db: Db;
  url: string;
  projectId: string;
  orchestrator: Orchestrator;
  file(name: string): string;
  create(body: string, extra?: Record<string, unknown>): Promise<NodeView>;
  call<T = NodeView>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  node(id: string): NodeView;
  runs(nodeId: string): RunRow[];
  /** Waits for the node's Nth run (from 1) to have started and its process to be on record. */
  runStarted(nodeId: string, count?: number): Promise<RunRow>;
  /** Waits until the node has this many runs and none is still running. */
  runsEnded(nodeId: string, count?: number): Promise<RunRow[]>;
  atStage(nodeId: string, stage: string): Promise<NodeView>;
  /** Records a process ID the test will check, and clear up if the code under test leaves it. */
  pidFrom(name: string): Promise<number>;
  restartOrchestrator(options?: { graceMs?: number }): Promise<void>;
  /** Happens by itself when the test finishes. Calling it again does nothing. */
  close(): Promise<void>;
}

/** Stopping agents and the server is slow on Windows, where each process lookup is a PowerShell call. */
const CLOSE_TIMEOUT_MS = 60_000;

/**
 * A real server and orchestrator on a free port, in a throwaway AOP_HOME, launching fake agents that
 * use the real CLI. Only ever launches `fakeCommand`, or `fakeClaudeCommand` with `claude`. Call it inside
 * a test or `beforeEach`: it closes itself when the test finishes, pass or fail, and puts the environment
 * back even if it fails to start.
 */
export async function world(
  options: { config?: string; graceMs?: number; reconcileIntervalMs?: number; home?: Record<string, string>; claude?: boolean } = {},
): Promise<World> {
  const outer = { home: process.env["AOP_HOME"], path: process.env["PATH"], url: process.env["AOP_URL"] };
  const shim = aopShim();
  const fake = options.claude ? FAKE_CLAUDE : FAKE_AGENT;
  const home = makeHome({ "config.yaml": fakeConfig(options.config, options.claude ? fakeClaudeCommand : fakeCommand), ...options.home });
  expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain(fake.replaceAll("\\", "\\\\"));

  // What to undo, filled in as each part starts so that a failed start is undone too. Run in reverse,
  // every step even if one throws, and only once.
  const undo: (() => unknown)[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      for (const step of undo.reverse()) await Promise.resolve().then(step).catch((error: unknown) => errors.push(error));
      if (errors.length > 0) throw errors[0];
    })());
  onTestFinished(close, CLOSE_TIMEOUT_MS);

  process.env["AOP_HOME"] = home;
  process.env["PATH"] = `${shim}${delimiter}${outer.path}`;
  undo.push(() => {
    process.env["AOP_HOME"] = outer.home;
    process.env["PATH"] = outer.path;
    if (outer.url === undefined) delete process.env["AOP_URL"];
    else process.env["AOP_URL"] = outer.url;
  });

  const pids = new Set<number>();
  // Only ever process IDs that a fake agent reported in this test.
  undo.push(async () => {
    for (const pid of pids) if (isAlive(pid)) await killTree(pid);
  });

  const db = openDb();
  undo.push(() => db.close());
  const repo = makeRepo();
  const project = addProject(db, { repo_path: repo });
  const changes = new ChangeFeed();
  const scratch = mkdtempSync(join(aopHome(), "scratch-"));
  mkdirSync(scratch, { recursive: true });

  const makeOrchestrator = (graceMs?: number) =>
    new Orchestrator(db, {
      changes,
      graceMs: graceMs ?? options.graceMs ?? 500,
      ...(options.reconcileIntervalMs === undefined ? {} : { reconcileIntervalMs: options.reconcileIntervalMs }),
    });
  const holder = { current: makeOrchestrator() };
  // The API reaches the orchestrator through this, so that a test can restart it behind a running server.
  const proxy = new Proxy({} as Orchestrator, {
    get(_target, name) {
      const value = holder.current[name as keyof Orchestrator] as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(holder.current) : value;
    },
  });
  const server: RunningServer = await startServer(db, 0, { changes, orchestrator: proxy });
  undo.push(() => server.close());
  const url = `http://127.0.0.1:${server.port}`;
  process.env["AOP_URL"] = url;
  undo.push(() => holder.current.shutdown());
  await holder.current.start(url);

  const self: World = {
    home,
    repo,
    db,
    url,
    projectId: project.id,
    get orchestrator() {
      return holder.current;
    },
    file: (name) => join(scratch, name),
    async call<T = NodeView>(method: string, path: string, body?: unknown) {
      const init: RequestInit = { method };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(`${url}/api${path}`, init);
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // The log and the context are plain text.
      }
      return { status: response.status, body: parsed as T };
    },
    async create(body, extra = {}) {
      const res = await self.call<NodeView>("POST", `/projects/${project.id}/nodes`, {
        type: "hotfix",
        title: "A node",
        body,
        ...extra,
      });
      if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
      return res.body;
    },
    node: (id) => db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeView,
    runs: (nodeId) => db.prepare("SELECT * FROM runs WHERE node_id = ? ORDER BY rowid").all(nodeId) as RunRow[],
    async runStarted(nodeId, count = 1) {
      return until(`run ${count} on ${nodeId} to start`, () => {
        const run = self.runs(nodeId)[count - 1];
        if (!run) return null;
        const recorded = db.prepare("SELECT process_start FROM agent_processes WHERE id = ?").get(run.id) as
          | { process_start: string | null }
          | undefined;
        return (run.status === "running" && recorded?.process_start) || run.status === "exited" ? run : null;
      });
    },
    async runsEnded(nodeId, count = 1) {
      return until(`${count} runs on ${nodeId} to end`, () => {
        const runs = self.runs(nodeId);
        return runs.length >= count && runs.every((run) => run.status === "exited") ? runs : null;
      });
    },
    async atStage(nodeId, stage) {
      await until(`${nodeId} to reach ${stage}, now ${self.node(nodeId).stage}`, () => self.node(nodeId).stage === stage);
      return self.node(nodeId);
    },
    async pidFrom(name) {
      const pid = await pidIn(self.file(name));
      pids.add(pid);
      return pid;
    },
    async restartOrchestrator({ graceMs } = {}) {
      await holder.current.shutdown();
      holder.current = makeOrchestrator(graceMs);
      await holder.current.start(url);
    },
    close,
  };
  return self;
}
