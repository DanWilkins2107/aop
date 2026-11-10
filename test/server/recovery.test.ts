import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { openDb } from "../../src/server/db.js";
import { isAlive, killTree, readProcessStarts, waitGone } from "../../src/server/osProcesses.js";
import { listProcesses, recordProcess } from "../../src/server/runs.js";
import type { AgentProcessView, NodeView, ProjectRow, ReapResult } from "../../src/shared/api.js";
import { directives, fakeConfig, nodeArgs, pidIn, settle, toolCall, until, world, type World } from "./agents.helpers.js";
import { makeHome, makeRepo } from "./helpers.js";

const TIMEOUT = { timeout: 120_000 };

/** Long-running processes the tests start themselves, standing in for ones AOP has lost track of. */
const strays: ChildProcess[] = [];
function stray(): ChildProcess & { pid: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
    stdio: "ignore",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  strays.push(child);
  return child as ChildProcess & { pid: number };
}

async function clearStrays(): Promise<void> {
  for (const child of strays.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && isAlive(child.pid)) await killTree(child.pid);
  }
}

describe("recovery with the orchestrator restarted in place", () => {
  let w: World;
  afterEach(clearStrays);

  it("a clean shutdown stops agents and returns nodes to the queue, not to failed", TIMEOUT, async () => {
    w = await world();
    const node = await w.create(directives(`pid ${w.file("agent.pid")}`, `child ${w.file("child.pid")}`, `ifnot AFTER :: hang`));
    const [pid, child] = [await w.pidFrom("agent.pid"), await w.pidFrom("child.pid")];
    await w.runStarted(node.id);

    await w.orchestrator.shutdown();
    expect(await waitGone(pid, 10_000)).toBe(true);
    expect(await waitGone(child, 10_000)).toBe(true);
    expect(w.node(node.id)).toMatchObject({ stage: "implement", claimed_by: null });
    expect(w.runs(node.id)[0]).toMatchObject({ status: "exited", end_reason: "shutdown" });
    expect(listProcesses(w.db)).toEqual([]);

    await w.restartOrchestrator();
    const second = await w.runStarted(node.id, 2);
    expect(second.status).toBe("running");
    expect(w.node(node.id).stage).toBe("implement");
  });

  it("a clean shutdown marks each run before killing it, so one that outlives the shutdown is requeued, not failed", TIMEOUT, async () => {
    w = await world();
    const node = await w.create(directives(`pid ${w.file("agent.pid")}`, "hang"));
    await w.pidFrom("agent.pid");
    await w.runStarted(node.id);

    const shuttingDown = w.orchestrator.shutdown();
    // Nothing has been killed yet: the kill can't come before this test yields.
    expect(w.runs(node.id)[0]).toMatchObject({ status: "running", shutting_down: 1 });
    await shuttingDown;
    expect(w.runs(node.id)[0]).toMatchObject({ status: "exited", end_reason: "shutdown" });

    // As a run whose process took longer to die than the shutdown waited leaves things: still
    // `running` and claimed, with nothing this server is tracking.
    const stuck = await w.create("", { stage: "pr_review", type: "dev" });
    w.db
      .prepare("INSERT INTO runs (id, created_at, node_id, stage, status, log_path, shutting_down) VALUES ('stuck-run', 'now', ?, 'pr_review', 'running', '/none', 1)")
      .run(stuck.id);
    w.db.prepare("UPDATE nodes SET claimed_by = 'agent' WHERE id = ?").run(stuck.id);

    await w.restartOrchestrator();
    expect(w.node(stuck.id)).toMatchObject({ stage: "pr_review", claimed_by: null });
    expect(w.runs(stuck.id)[0]).toMatchObject({ status: "exited", end_reason: "shutdown" });
    // And the node that was cleanly stopped starts again.
    await w.runStarted(node.id, 2);
  });

  it("a shutdown during a split keeps the split, and its children held", TIMEOUT, async () => {
    w = await world();
    const parent = await w.create(directives(`ifnot Stage: splitting :: ${toolCall("split_start")}`, "hang"), {
      type: "triage",
      stage: "split_approved",
    });
    await w.atStage(parent.id, "splitting");
    await w.runStarted(parent.id);
    const child = await w.call<NodeView>("POST", `/projects/${w.projectId}/nodes`, { type: "hotfix", title: "c", parent_id: parent.id });

    await w.restartOrchestrator();
    await w.runStarted(parent.id, 2);
    expect(w.node(parent.id).stage).toBe("splitting");
    expect(w.runs(child.body.id)).toEqual([]);
  });

  it("kills a recorded child whose launching shell has gone, as long as its identity still matches", TIMEOUT, async () => {
    w = await world();
    const gone = stray();
    const goneStart = (await readProcessStarts([gone.pid])).get(gone.pid) as string;
    const agent = stray();
    const agentStart = (await readProcessStarts([agent.pid])).get(agent.pid) as string;
    const reused = stray();
    await killTree(gone.pid);
    await waitGone(gone.pid, 10_000);

    recordProcess(w.db, { id: "shell-gone", node_id: "deleted-node" }, gone.pid, "fake");
    w.db
      .prepare("UPDATE agent_processes SET process_start = ?, children = ? WHERE id = 'shell-gone'")
      .run(goneStart, JSON.stringify([{ pid: agent.pid, start: agentStart }, { pid: reused.pid, start: "1234" }]));

    const res = await w.call<ReapResult>("POST", "/agents/reap");
    expect(res.body.killed.map((k) => k.run_id)).toEqual(["shell-gone"]);
    if (process.platform === "win32") {
      expect(await waitGone(agent.pid, 10_000)).toBe(true);
      // A recorded child ID that now belongs to something else is left alone.
      expect(isAlive(reused.pid)).toBe(true);
    }
    expect(listProcesses(w.db)).toEqual([]);
  });

  it("a process with a running row that this server didn't start is killed, and its node fails", TIMEOUT, async () => {
    w = await world();
    const node = await w.create("", { stage: "pr_review", type: "dev" });
    const process_ = stray();
    const start = (await readProcessStarts([process_.pid])).get(process_.pid);
    expect(start).toBeDefined();
    const run = { id: "orphan-run", node_id: node.id };
    w.db.prepare("INSERT INTO runs (id, created_at, node_id, stage, status, log_path) VALUES (?, 'now', ?, 'pr_review', 'running', ?)").run(run.id, node.id, join(w.home, "orphan.log"));
    w.db.prepare("UPDATE nodes SET claimed_by = 'agent' WHERE id = ?").run(node.id);
    recordProcess(w.db, run, process_.pid, "fake");
    w.db.prepare("UPDATE agent_processes SET process_start = ? WHERE id = ?").run(start, run.id);

    await w.restartOrchestrator();
    expect(await waitGone(process_.pid, 10_000)).toBe(true);
    expect(w.node(node.id)).toMatchObject({ stage: "failed", claimed_by: null, return_stage: "pr_review" });
    expect(w.runs(node.id)[0]).toMatchObject({ status: "exited", end_reason: "failed" });
    expect(listProcesses(w.db)).toEqual([]);
  });

  it("a dead run found on restart goes to failed, unless its node had already moved on", TIMEOUT, async () => {
    w = await world();
    const dead = await w.create("", { stage: "pr_review", type: "dev" });
    const moved = await w.create("", { stage: "pr_review", type: "dev" });
    const insert = w.db.prepare("INSERT INTO runs (id, created_at, node_id, stage, status, log_path, left_via, left_actor, left_at) VALUES (?, 'now', ?, 'pr_review', 'running', '/none', ?, ?, ?)");
    insert.run("dead-run", dead.id, null, null, null);
    insert.run("moved-run", moved.id, "next", "agent", new Date().toISOString());

    await w.restartOrchestrator();
    expect(w.node(dead.id).stage).toBe("failed");
    expect(w.node(moved.id).stage).toBe("pr_review");
    expect(w.runs(moved.id)[0]).toMatchObject({ status: "exited", end_reason: "reported" });
  });

  it("releases a claim a crash left with no run behind it", TIMEOUT, async () => {
    w = await world();
    const node = await w.create("", { stage: "pr_review", type: "dev" });
    w.db.prepare("UPDATE nodes SET claimed_by = 'agent' WHERE id = ?").run(node.id);
    await w.restartOrchestrator();
    expect(w.node(node.id).claimed_by).toBeNull();
  });
});

describe("reap and identity", () => {
  let w: World;
  afterEach(clearStrays);

  async function onRecord(id: string, nodeId: string, process_: { pid: number }, start: string | null): Promise<void> {
    recordProcess(w.db, { id, node_id: nodeId }, process_.pid, "fake command");
    w.db.prepare("UPDATE agent_processes SET process_start = ? WHERE id = ?").run(start, id);
  }

  it("kills what shouldn't exist and nothing else", TIMEOUT, async () => {
    w = await world({ graceMs: 60_000 });
    const legit = await w.create(directives(`pid ${w.file("legit.pid")}`, "hang"));
    const legitPid = await w.pidFrom("legit.pid");
    const legitRun = await w.runStarted(legit.id);
    const unrelated = stray();

    // No running row: its project was deleted, or its run closed while the kill failed.
    const orphan = stray();
    const [orphanStart] = [(await readProcessStarts([orphan.pid])).get(orphan.pid)];
    await onRecord("orphan", "deleted-node", orphan, orphanStart ?? null);

    const res = await w.call<ReapResult>("POST", "/agents/reap");
    expect(res.status).toBe(200);
    expect(res.body.killed.map((k) => k.run_id)).toEqual(["orphan"]);
    expect(res.body.killed[0]?.reason).toContain("no run");
    expect(await waitGone(orphan.pid, 10_000)).toBe(true);

    expect(isAlive(legitPid)).toBe(true);
    expect(isAlive(unrelated.pid)).toBe(true);
    expect(w.runs(legit.id)[0]).toMatchObject({ id: legitRun.id, status: "running" });
    expect(listProcesses(w.db).map((row) => row.id)).toEqual([legitRun.id]);
  });

  it("an agent it reaps because a parent was invalidated is held, not stopped", TIMEOUT, async () => {
    // No reconcile on a timer, so the reap is the one to find it.
    w = await world({ reconcileIntervalMs: 600_000 });
    const parent = await w.create("", { stage: "pr_review", type: "dev" });
    const child = await w.create(directives(`pid ${w.file("child.pid")}`, "hang"), { parent_id: parent.id });
    const pid = await w.pidFrom("child.pid");
    await w.runStarted(child.id);
    // Behind the orchestrator's back, so that only the reap sees it.
    w.db.prepare("UPDATE nodes SET stage = 'invalidated', invalidation_reason = 'Not wanted' WHERE id = ?").run(parent.id);

    const res = await w.call<ReapResult>("POST", "/agents/reap");
    expect(res.body.killed.map((k) => k.reason)).toEqual(["its node is invalidated by a parent"]);
    expect(await waitGone(pid, 10_000)).toBe(true);
    const [run] = await w.runsEnded(child.id);
    expect(run).toMatchObject({ end_reason: "held" });
    expect(w.node(child.id)).toMatchObject({ stage: "implement", claimed_by: null });
  });

  it("won't kill a reused process ID: the start time has to match", TIMEOUT, async () => {
    w = await world();
    const innocent = stray();
    await onRecord("old-run", "deleted-node", innocent, "1234567890");

    const res = await w.call<ReapResult>("POST", "/agents/reap");
    expect(res.body.killed).toEqual([]);
    expect(res.body.skipped.map((s) => s.run_id)).toEqual(["old-run"]);
    await settle(500);
    expect(isAlive(innocent.pid)).toBe(true);
    // It isn't this record's process, so the record goes.
    expect(listProcesses(w.db)).toEqual([]);
  });

  it("won't kill a process whose start time it never read", TIMEOUT, async () => {
    w = await world();
    const unknown = stray();
    await onRecord("unread", "deleted-node", unknown, null);

    const res = await w.call<ReapResult>("POST", "/agents/reap");
    expect(res.body.killed).toEqual([]);
    expect(res.body.skipped[0]?.reason).toContain("start time");
    expect(isAlive(unknown.pid)).toBe(true);
    const listed = (await w.call<AgentProcessView[]>("GET", "/agents")).body;
    expect(listed.find((agent) => agent.run_id === "unread")).toMatchObject({ identity: "unverified", status: "orphaned" });
  });

  it("forgets a record whose process has gone", TIMEOUT, async () => {
    w = await world();
    const gone = stray();
    const start = (await readProcessStarts([gone.pid])).get(gone.pid);
    await onRecord("gone", "deleted-node", gone, start ?? null);
    await killTree(gone.pid);
    await waitGone(gone.pid, 10_000);
    expect((await w.call<ReapResult>("POST", "/agents/reap")).body).toEqual({ killed: [], skipped: [] });
    expect(listProcesses(w.db)).toEqual([]);
  });

  it("kills children along with the process it reaps", TIMEOUT, async () => {
    w = await world();
    // A shell-less parent with a child of its own, not started by AOP, to stand for an orphaned agent.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
         require("node:fs").writeFileSync(${JSON.stringify(w.file("sub.pid"))}, String(child.pid));
         setInterval(() => {}, 60000);`,
      ],
      { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true },
    ) as ChildProcess & { pid: number };
    strays.push(parent);
    const sub = await w.pidFrom("sub.pid");
    const start = (await readProcessStarts([parent.pid])).get(parent.pid);
    await onRecord("with-child", "deleted-node", parent, start ?? null);

    await w.call<ReapResult>("POST", "/agents/reap");
    expect(await waitGone(parent.pid, 10_000)).toBe(true);
    expect(await waitGone(sub, 10_000)).toBe(true);
  });

  it("ps lists each agent and its node, and marks one that's exiting", TIMEOUT, async () => {
    w = await world({ graceMs: 60_000 });
    const hanging = await w.create(directives("hang"), { title: "Hanging" });
    const leaving = await w.create(directives(toolCall("next", { outcome: "fixed" }), "hang"), { title: "Leaving" });
    await w.runStarted(hanging.id);
    await w.atStage(leaving.id, "done");
    await w.runStarted(leaving.id);

    const listed = (await w.call<AgentProcessView[]>("GET", "/agents")).body;
    const byNode = new Map(listed.map((agent) => [agent.node_id, agent]));
    expect(byNode.get(hanging.id)).toMatchObject({ node_title: "Hanging", stage: "implement", status: "running", identity: "confirmed" });
    expect(byNode.get(leaving.id)).toMatchObject({ node_title: "Leaving", stage: "done", status: "exiting" });
    expect(byNode.get(hanging.id)?.pid).toBe(w.runs(hanging.id)[0]?.pid);
  });
});

/** A real server process, which can really crash. Never on a fixed port, so it can't touch a real one. */
function realServer(home: string) {
  const child = spawn(process.execPath, [...nodeArgs("src/server/main.ts"), "--port", "0"], {
    env: { ...process.env, AOP_HOME: home },
    stdio: "pipe",
    windowsHide: true,
  });
  strays.push(child);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const url = until("the server's URL", () => /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]);
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  return { child, url, output: () => output, exited };
}

describe("a real server process", () => {
  afterEach(clearStrays);

  async function setUp() {
    const home = makeHome({ "config.yaml": fakeConfig() });
    const first = realServer(home);
    const url = await first.url;
    const post = async <T>(path: string, body: unknown) =>
      (await (await fetch(`${url}/api${path}`, { method: "POST", body: JSON.stringify(body) })).json()) as T;
    const project = await post<ProjectRow>("/projects", { repo_path: makeRepo() });
    return { home, first, url, post, project };
  }

  /** A fake agent's process, killed when the test finishes if a failure left it running. */
  async function agentPid(file: string): Promise<number> {
    const pid = await pidIn(file);
    onTestFinished(async () => {
      if (isAlive(pid)) await killTree(pid);
    });
    return pid;
  }

  function dbNode(home: string, id: string): NodeView {
    const db = openDb(join(home, "aop.db"));
    try {
      return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeView;
    } finally {
      db.close();
    }
  }

  it("after a crash, the next start kills the orphan and fails its node", TIMEOUT, async () => {
    const { home, first, post, project } = await setUp();
    const pidFile = join(home, "agent.pid");
    const childFile = join(home, "child.pid");
    const node = await post<NodeView>(`/projects/${project.id}/nodes`, {
      type: "hotfix",
      title: "t",
      body: directives(`pid ${pidFile}`, `child ${childFile}`, "hang"),
    });
    const pid = await agentPid(pidFile);
    const child = await agentPid(childFile);
    await until("the process record", () => {
      const db = openDb(join(home, "aop.db"));
      try {
        return (db.prepare("SELECT children FROM agent_processes").get() as { children: string | null } | undefined)?.children;
      } finally {
        db.close();
      }
    });

    // TerminateProcess on Windows and SIGKILL elsewhere: no handler runs, which is what a crash is.
    first.child.kill("SIGKILL");
    await first.exited;
    expect(isAlive(pid)).toBe(true);

    const second = realServer(home);
    await second.url;
    try {
      expect(await waitGone(pid, 20_000)).toBe(true);
      expect(await waitGone(child, 20_000)).toBe(true);
      await until("the node to fail", () => dbNode(home, node.id).stage === "failed");
      expect(dbNode(home, node.id)).toMatchObject({ return_stage: "implement", claimed_by: null });
    } finally {
      second.child.kill("SIGKILL");
      await second.exited;
    }
  });

  it("a crash straight after launch leaves nothing the next start can't find, even what the agent starts later", TIMEOUT, async () => {
    const { home, first, post, project } = await setUp();
    const file = (name: string) => join(home, name);
    const node = await post<NodeView>(`/projects/${project.id}/nodes`, {
      type: "hotfix",
      title: "t",
      // Everything below the agent starts after the server has gone, so none of it is on record.
      body: directives(`pid ${file("agent.pid")}`, "sleep 2500", `child ${file("child.pid")}`, `grandchild ${file("grandchild.pid")}`, "hang"),
    });
    const readPid = (name: string) => () => {
      try {
        return Number(readFileSync(file(name), "utf8")) || null;
      } catch {
        return null;
      }
    };
    // As soon as the agent has its prompt, which is the earliest a crash leaves anything to find:
    // before that, the broken pipe means the agent never gets its instructions.
    const agent = await until("agent", readPid("agent.pid"), 30_000);
    // TerminateProcess on Windows and SIGKILL elsewhere: no handler runs, which is what a crash is.
    first.child.kill("SIGKILL");
    await first.exited;
    const db = openDb(join(home, "aop.db"));
    const record = db.prepare("SELECT children FROM agent_processes").get() as { children: string | null };
    db.close();
    // What the agent starts from here on can't be on record, whatever the record already holds.
    expect(record).toBeDefined();

    const pids = [agent, await until("child", readPid("child.pid")), await until("grandchild", readPid("grandchild.pid"))];
    expect(record.children ?? "").not.toContain(String(pids[1]));
    try {
      expect(pids.map(isAlive)).toEqual([true, true, true]);
      const second = realServer(home);
      await second.url;
      try {
        for (const pid of pids) expect(await waitGone(pid, 30_000)).toBe(true);
        await until("the node to fail", () => dbNode(home, node.id).stage === "failed");
        await until("the record to go", () => {
          const db = openDb(join(home, "aop.db"));
          try {
            return (db.prepare("SELECT count(*) AS n FROM agent_processes").get() as { n: number }).n === 0;
          } finally {
            db.close();
          }
        });
      } finally {
        second.child.kill("SIGKILL");
        await second.exited;
      }
    } finally {
      for (const pid of pids) if (isAlive(pid)) await killTree(pid);
    }
  });

  it("a second server on the same AOP_HOME refuses to start, names the first, and leaves its agents alone", TIMEOUT, async () => {
    const { home, first, url, post, project } = await setUp();
    const pidFile = join(home, "agent.pid");
    const node = await post<NodeView>(`/projects/${project.id}/nodes`, {
      type: "hotfix",
      title: "t",
      body: directives(`pid ${pidFile}`, "hang"),
    });
    const pid = await until("the agent's pid", () => {
      try {
        return Number(readFileSync(pidFile, "utf8")) || null;
      } catch {
        return null;
      }
    });
    try {
      const second = realServer(home);
      await second.exited;
      expect(second.child.exitCode).toBe(1);
      expect(second.output()).toContain("Another AOP server is already running");
      expect(second.output()).toContain(`process ${first.child.pid} at ${url}, MCP at http://127.0.0.1:`);
      expect(second.output()).toContain("so two can't run at once on one machine");
      expect(second.output()).not.toMatch(/AOP listening/);

      expect(isAlive(pid)).toBe(true);
      expect(isAlive(first.child.pid!)).toBe(true);
      expect(dbNode(home, node.id)).toMatchObject({ stage: "implement", claimed_by: "agent" });
      // The first server still works.
      expect((await fetch(`${url}/api/projects`)).status).toBe(200);
    } finally {
      first.child.kill("SIGKILL");
      await first.exited;
      if (isAlive(pid)) await killTree(pid);
    }

    // A crash leaves no lock behind: the next server starts.
    const third = realServer(home);
    await third.url;
    third.child.kill("SIGKILL");
    await third.exited;
  });

  it("after a crash where the agent died too, the next start fails its node", TIMEOUT, async () => {
    const { home, first, post, project } = await setUp();
    const pidFile = join(home, "agent.pid");
    const node = await post<NodeView>(`/projects/${project.id}/nodes`, {
      type: "hotfix",
      title: "t",
      body: directives(`pid ${pidFile}`, "hang"),
    });
    const pid = await agentPid(pidFile);
    first.child.kill("SIGKILL");
    await first.exited;
    await killTree(pid);
    await waitGone(pid, 10_000);

    const second = realServer(home);
    await second.url;
    try {
      await until("the node to fail", () => dbNode(home, node.id).stage === "failed");
    } finally {
      second.child.kill("SIGKILL");
      await second.exited;
    }
  });

  // child.kill("SIGTERM") on Windows is TerminateProcess, so no handler can run. The end-to-end run
  // covers a real Ctrl+C on Windows.
  it.skipIf(process.platform === "win32")("SIGTERM stops agents and queues the node", TIMEOUT, async () => {
    const { home, first, post, project } = await setUp();
    const pidFile = join(home, "agent.pid");
    const node = await post<NodeView>(`/projects/${project.id}/nodes`, {
      type: "hotfix",
      title: "t",
      body: directives(`pid ${pidFile}`, "hang"),
    });
    const pid = await agentPid(pidFile);
    first.child.kill("SIGTERM");
    await first.exited;
    expect(isAlive(pid)).toBe(false);
    expect(dbNode(home, node.id)).toMatchObject({ stage: "implement", claimed_by: null });
  });
});
