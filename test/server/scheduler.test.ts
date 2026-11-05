import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeFeed } from "../../src/server/changes.js";
import { startableNodes, type NodeView } from "../../src/server/nodes.js";
import { RUN_EVENT, Scheduler, SKIP_EVENT } from "../../src/server/scheduler.js";
import { loadConfig } from "../../src/server/config.js";
import { harness, type Harness } from "./helpers.js";

/** A process of its own, so the scheduler is tested against `scheduled` added to a user's type. */
const SCHEDULED_STAGES = `
start: work

stages:
  write_spec:  { turn: agent, color: "#22b8cf", prompt: ./prompts/write_spec.md }
  review:      { turn: human, color: "#cddc39" }
  draft:       { turn: human, color: "#ff9800" }

types:
  work:
    start: write_spec
    stages:
      write_spec: { next: { done: review } }
      review:     { next: { approve: done, reject: write_spec } }
  weekly:
    start: scheduled
    stages:
      scheduled:  { next: { fire: work } }
  report:
    start: scheduled
    stages:
      scheduled:  { next: { fire: draft } }
      draft:      { next: { finished: done } }
`;

const at = (iso: string) => vi.setSystemTime(new Date(iso));

let h: Harness;
let changes: ChangeFeed;
let scheduler: Scheduler;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-03-02T10:00:30Z");
  h = harness();
  h.rewriteStages(SCHEDULED_STAGES);
  changes = new ChangeFeed();
  scheduler = new Scheduler(h.db, { changes });
});

afterEach(() => {
  scheduler.stop();
  h.close();
  vi.useRealTimers();
});

const createScheduled = (type = "weekly", cron = "*/5 * * * *", extra: Record<string, unknown> = {}) =>
  h.create(type, { cron, title: "Weekly report", body: "Summarise the week's merged PRs.", ...extra });

const children = (id: string) =>
  h.db.prepare("SELECT * FROM nodes WHERE spawned_by = ? ORDER BY rowid").all(id) as NodeView[];

const events = (id: string, kind: string) =>
  (h.db.prepare("SELECT data FROM events WHERE node_id = ? AND kind = ? ORDER BY rowid").all(id, kind) as { data: string }[]).map(
    (row) => JSON.parse(row.data) as Record<string, unknown>,
  );

describe("cron validation", () => {
  it("refuses invalid crons on create and move, with the parser's reason", async () => {
    const path = `/api/projects/${h.projectId}/nodes`;
    for (const cron of ["61 * * * *", "* * * *", "* * * * * *", "0 0 31 2 *", "tomorrow"]) {
      const res = await h.call<{ error: { message: string } }>("POST", path, { type: "weekly", title: "x", cron });
      expect(res.status, cron).toBe(400);
      expect(res.body.error.message).toContain("Invalid cron");
    }
    expect((await h.call("POST", path, { type: "weekly", title: "x", cron: "0 9 * * MON-FRI" })).status).toBe(201);

    const node = await h.create("work");
    expect((await h.post(node.id, "move", { stage: "scheduled", type: "weekly", cron: "0 25 * * *" })).status).toBe(400);
    expect((await h.post(node.id, "move", { stage: "scheduled", type: "weekly", cron: "@daily" })).status).toBe(200);
  });
});

describe("firing", () => {
  it("creates a child with a copy of the description, spawned_by and a subtask edge, and stays put", async () => {
    const node = await createScheduled();

    at("2026-03-02T10:04:59Z");
    expect(scheduler.tick()).toEqual([]);

    let notified = 0;
    changes.subscribe(() => notified++);
    at("2026-03-02T10:05:00Z");
    const [result] = scheduler.tick();
    expect(result).toMatchObject({ nodeId: node.id, fired: true, dueAt: "2026-03-02T10:05:00.000Z" });
    expect(notified).toBe(1);

    const [child] = children(node.id);
    expect(child).toMatchObject({
      title: "Weekly report",
      body: "Summarise the week's merged PRs.",
      spawned_by: node.id,
      project_id: h.projectId,
      // `next` targets the work type, so the child enters at its start.
      type: "work",
      stage: "write_spec",
    });
    const edges = h.db.prepare("SELECT kind, target_id FROM edges WHERE source_id = ?").all(node.id);
    expect(edges).toEqual([{ kind: "subtask", target_id: child!.id }]);
    expect(await h.node(node.id)).toMatchObject({ stage: "scheduled", turn: null, available_outcomes: [] });
    expect(events(node.id, RUN_EVENT)).toEqual([{ due_at: "2026-03-02T10:05:00.000Z", child_id: child!.id }]);

    // Firing once per slot: the same slot again does nothing.
    expect(scheduler.tick()).toEqual([]);
  });

  it("starts the child at a stage in the same type when next names one", async () => {
    const node = await createScheduled("report");
    at("2026-03-02T10:05:00Z");
    scheduler.tick();
    expect(children(node.id)[0]).toMatchObject({ type: "report", stage: "draft" });
  });

  it("copies the description as it is when the cron fires", async () => {
    const node = await createScheduled("report");
    await h.call("PATCH", `/api/nodes/${node.id}`, { body: "Edited before the run." });
    at("2026-03-02T10:05:00Z");
    scheduler.tick();
    expect(children(node.id)[0]?.body).toBe("Edited before the run.");
  });

  it("never runs an agent on the scheduled node itself", async () => {
    const node = await createScheduled();
    at("2026-03-02T10:05:00Z");
    scheduler.tick();
    const startable = startableNodes(h.db, loadConfig().graph).map((n) => n.id);
    expect(startable).not.toContain(node.id);
    // Its child is on an agent stage, so that one is for the orchestrator.
    expect(startable).toContain(children(node.id)[0]!.id);
  });
});

describe("skipping", () => {
  it("skips and logs a run while the previous child is unfinished, then fires once it's done", async () => {
    const node = await createScheduled("report");
    at("2026-03-02T10:05:00Z");
    scheduler.tick();
    const [first] = children(node.id);

    at("2026-03-02T10:10:00Z");
    expect(scheduler.tick()).toEqual([
      { nodeId: node.id, dueAt: "2026-03-02T10:10:00.000Z", fired: false, reason: "previous_unfinished" },
    ]);
    expect(children(node.id)).toHaveLength(1);
    expect(events(node.id, SKIP_EVENT)).toEqual([
      { due_at: "2026-03-02T10:10:00.000Z", reason: "previous_unfinished", previous_child_id: first!.id },
    ]);

    expect((await h.post(first!.id, "next", { outcome: "finished", actor: "human" })).body.stage).toBe("done");
    at("2026-03-02T10:15:00Z");
    expect(scheduler.tick()[0]).toMatchObject({ fired: true });
    expect(children(node.id)).toHaveLength(2);
  });

  it("counts an invalidated child as finished", async () => {
    const node = await createScheduled("report");
    at("2026-03-02T10:05:00Z");
    scheduler.tick();
    await h.post(children(node.id)[0]!.id, "invalidate", { reason: "Not needed", actor: "human" });
    at("2026-03-02T10:10:00Z");
    expect(scheduler.tick()[0]).toMatchObject({ fired: true });
  });
});

describe("stopping", () => {
  it("stops firing once invalidated, and starts afresh from the restore", async () => {
    const node = await createScheduled();
    expect((await h.post(node.id, "invalidate", { reason: "No longer wanted", actor: "human" })).status).toBe(200);
    at("2026-03-02T11:00:00Z");
    expect(scheduler.tick()).toEqual([]);
    expect(children(node.id)).toHaveLength(0);

    expect((await h.post(node.id, "restore")).body.stage).toBe("scheduled");
    // Slots missed while invalidated aren't caught up.
    expect(scheduler.tick()).toEqual([]);
    at("2026-03-02T11:05:00Z");
    expect(scheduler.tick()[0]).toMatchObject({ fired: true });
  });

  it("stops firing once moved off scheduled", async () => {
    const node = await createScheduled("report");
    await h.post(node.id, "move", { stage: "draft" });
    at("2026-03-02T11:00:00Z");
    expect(scheduler.tick()).toEqual([]);
  });

  it("stops firing when its type no longer lists scheduled", async () => {
    const node = await createScheduled("report");
    h.rewriteStages(SCHEDULED_STAGES.replace("      scheduled:  { next: { fire: draft } }\n", "").replace("start: scheduled\n    stages:\n      draft", "start: draft\n    stages:\n      draft"));
    expect((await h.node(node.id)).stage_exists).toBe(false);
    at("2026-03-02T11:00:00Z");
    expect(scheduler.tick()).toEqual([]);
  });

  it("fires nothing while stages.yaml is invalid", async () => {
    await createScheduled();
    h.rewriteStages("start: nowhere\nstages: {}\ntypes: {}\n");
    at("2026-03-02T11:00:00Z");
    expect(scheduler.tick()).toEqual([]);
  });
});

describe("restart", () => {
  it("fires once for the latest missed slot, not once for each", async () => {
    const node = await createScheduled("report");
    at("2026-03-02T10:05:00Z");
    scheduler.tick();
    await h.post(children(node.id)[0]!.id, "next", { outcome: "finished", actor: "human" });
    scheduler.stop();

    // The server was off for an hour: eleven slots went by.
    at("2026-03-02T11:02:00Z");
    const restarted = new Scheduler(h.db, { changes });
    const results = restarted.tick();
    expect(results).toEqual([
      expect.objectContaining({ fired: true, dueAt: "2026-03-02T11:00:00.000Z" }),
    ]);
    expect(children(node.id)).toHaveLength(2);
    expect(restarted.tick()).toEqual([]);
    restarted.stop();
  });

  it("fires from its own timer once started", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: new Date("2026-03-02T10:01:00Z") });
    const node = await createScheduled("report");
    scheduler.start();
    vi.advanceTimersByTime(3 * 60_000);
    expect(children(node.id)).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(children(node.id)).toHaveLength(1);
    scheduler.stop();
    vi.advanceTimersByTime(60 * 60_000);
    expect(children(node.id)).toHaveLength(1);
  });
});
