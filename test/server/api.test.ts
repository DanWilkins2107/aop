import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdersOf, type EventView, type NodeView } from "../../src/server/nodes.js";
import { harness, makeRepo, STAGES_YAML, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(() => {
  h = harness();
});
afterEach(() => h.close());

function errorOf(res: { body: unknown }): { code: string; message: string; details?: unknown } {
  return (res.body as { error: { code: string; message: string; details?: unknown } }).error;
}

async function stageEvents(nodeId: string): Promise<Record<string, unknown>[]> {
  const res = await h.call<EventView[]>("GET", `/api/nodes/${nodeId}/events`);
  return res.body.filter((e) => e.kind === "stage_changed").map((e) => e.data as Record<string, unknown>);
}

async function child(parent: string, type = "dev"): Promise<NodeView> {
  const node = await h.create(type);
  const res = await h.call("POST", `/api/nodes/${parent}/edges`, { target_id: node.id, kind: "subtask" });
  expect(res.status).toBe(201);
  return node;
}

describe("projects", () => {
  it("adds by name and path, and lists", async () => {
    const res = await h.call("POST", "/api/projects", { repo_path: makeRepo(), name: "Mine" });
    expect(res.status).toBe(201);
    expect(res.body["name"]).toBe("Mine");
    const list = await h.call<{ id: string }[]>("GET", "/api/projects");
    expect(list.body.map((p) => p.id)).toContain(res.body["id"]);
  });
});

describe("creating nodes", () => {
  it("starts at the type's start and reports outcomes", async () => {
    const node = await h.create("triage", { title: "Hello", body: "Details" });
    expect(node).toMatchObject({
      title: "Hello",
      body: "Details",
      type: "triage",
      stage: "awaiting_agent_breakdown",
      stage_exists: true,
      turn: "agent",
      invalidated_by_parent: false,
      blocked_by: [],
    });
    expect(node.available_outcomes).toEqual([
      { outcome: "ready", target: "dev" },
      { outcome: "split", target: "split_proposed" },
    ]);
    const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
    expect(events.body.map((e) => e.kind)).toEqual(["node_created"]);
  });

  it("gets and lists by project", async () => {
    const a = await h.create("dev");
    const b = await h.create("triage");
    expect((await h.node(a.id)).id).toBe(a.id);
    const list = await h.call<NodeView[]>("GET", `/api/projects/${h.projectId}/nodes`);
    expect(list.body.map((n) => n.id)).toEqual([a.id, b.id]);
    expect((await h.call("GET", "/api/nodes/missing")).status).toBe(404);
    expect((await h.call("GET", "/api/projects/missing/nodes")).status).toBe(404);
  });

  it("refuses an unknown type and an unknown project", async () => {
    const path = `/api/projects/${h.projectId}/nodes`;
    expect((await h.call("POST", path, { type: "nope", title: "x" })).status).toBe(400);
    expect((await h.call("POST", path, { type: "constructor", title: "x" })).status).toBe(400);
    expect((await h.call("POST", "/api/projects/missing/nodes", { type: "dev", title: "x" })).status).toBe(404);
  });

  it("checks the title, counting characters rather than UTF-16 units", async () => {
    const path = `/api/projects/${h.projectId}/nodes`;
    expect((await h.call("POST", path, { type: "dev", title: "" })).status).toBe(400);
    expect((await h.call("POST", path, { type: "dev", title: "   " })).status).toBe(400);
    expect((await h.call("POST", path, { type: "dev", title: "a".repeat(201) })).status).toBe(400);
    expect((await h.call("POST", path, { type: "dev", title: "😀".repeat(200) })).status).toBe(201);
  });

  it("requires a cron for scheduled, and only for scheduled", async () => {
    const path = `/api/projects/${h.projectId}/nodes`;
    expect((await h.call("POST", path, { type: "nightly", title: "x" })).status).toBe(400);
    expect((await h.call("POST", path, { type: "nightly", title: "x", cron: "tomorrow" })).status).toBe(400);
    expect((await h.call("POST", path, { type: "dev", title: "x", cron: "0 0 * * *" })).status).toBe(400);
    const node = await h.create("nightly", { cron: "0 0 * * *" });
    expect(node).toMatchObject({ stage: "scheduled", cron: "0 0 * * *" });
  });

  it("rejects malformed and unexpected input", async () => {
    const path = `/api/projects/${h.projectId}/nodes`;
    expect((await h.call("POST", path, { type: "dev", title: "x", typo: 1 })).status).toBe(400);
    const node = await h.create("dev");
    expect((await h.post(node.id, "next", { outcome: "done", actor: "robot" })).status).toBe(400);
    expect((await h.call("POST", path)).status).toBe(400);
  });
});

describe("next", () => {
  it("moves within a type and records an event", async () => {
    const node = await h.create("dev");
    const res = await h.post(node.id, "next", { outcome: "done", actor: "agent" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stage: "spec_review", type: "dev", turn: "human" });
    expect(res.body.available_outcomes.map((o) => o.outcome)).toEqual(["approve", "reject"]);
    expect((await stageEvents(node.id))[0]).toMatchObject({
      via: "next",
      outcome: "done",
      from_stage: "write_spec",
      to_stage: "spec_review",
    });
  });

  it("refuses an outcome not in the current stage's next, listing what is", async () => {
    const node = await h.create("dev");
    for (const outcome of ["approve", "constructor", "__proto__"]) {
      const res = await h.post(node.id, "next", { outcome });
      expect(res.status).toBe(409);
      expect(errorOf(res).details).toEqual({ available_outcomes: ["done"] });
    }
    expect((await h.node(node.id)).stage).toBe("write_spec");
    expect(await stageEvents(node.id)).toEqual([]);
  });

  it("uses the current type's next for a stage reused across types", async () => {
    const dev = await h.create("dev");
    await h.post(dev.id, "move", { stage: "implement" });
    const hotfix = await h.create("hotfix");
    expect((await h.post(dev.id, "next", { outcome: "fixed" })).status).toBe(409);
    expect((await h.post(hotfix.id, "next", { outcome: "pr_raised" })).status).toBe(409);
    expect((await h.post(hotfix.id, "next", { outcome: "fixed" })).body.stage).toBe("done");
    expect((await h.post(dev.id, "next", { outcome: "pr_raised" })).body.stage).toBe("pr_review");
  });

  it("enters another type at its start, updating the type", async () => {
    const node = await h.create("triage");
    const res = await h.post(node.id, "next", { outcome: "ready", actor: "agent" });
    expect(res.body).toMatchObject({ type: "dev", stage: "write_spec", turn: "agent" });
    expect((await stageEvents(node.id))[0]).toMatchObject({ from_type: "triage", to_type: "dev" });
  });

  it("walks the whole dev type to done, where no outcomes remain", async () => {
    const node = await h.create("dev");
    for (const outcome of ["done", "approve", "pr_raised", "changes", "pr_raised", "merged"]) {
      expect((await h.post(node.id, "next", { outcome })).status).toBe(200);
    }
    const done = await h.node(node.id);
    expect(done).toMatchObject({ stage: "done", available_outcomes: [], stage_exists: true, turn: null });
    expect((await h.post(node.id, "next", { outcome: "merged" })).status).toBe(409);
  });

  it("refuses an agent reporting an outcome on a human turn, but not a human on an agent turn", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "next", { outcome: "done", actor: "agent" });
    const res = await h.post(node.id, "next", { outcome: "approve", actor: "agent" });
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toContain("human turn");
    expect((await h.post(node.id, "next", { outcome: "approve", actor: "human" })).body.stage).toBe("implement");
    expect((await h.post(node.id, "next", { outcome: "pr_raised" })).body.stage).toBe("pr_review");
  });

  it("refuses broken_down without subtask children, then allows it", async () => {
    const node = await h.create("triage");
    await h.post(node.id, "next", { outcome: "split" });
    await h.post(node.id, "next", { outcome: "approve" });

    const refused = await h.post(node.id, "next", { outcome: "done" });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).message).toContain("no subtask children");

    // A blocks edge isn't a child, and neither is a removed subtask edge.
    const other = await h.create("dev");
    const blocks = await h.call<{ id: string }>("POST", `/api/nodes/${node.id}/edges`, { target_id: other.id, kind: "blocks" });
    const edge = await h.call<{ id: string }>("POST", `/api/nodes/${node.id}/edges`, {
      target_id: other.id,
      kind: "subtask",
    });
    await h.call("DELETE", `/api/edges/${edge.body.id}`);
    expect((await h.post(node.id, "next", { outcome: "done" })).status).toBe(409);

    await h.call("DELETE", `/api/edges/${blocks.body.id}`);
    await child(node.id);
    const ok = await h.post(node.id, "next", { outcome: "done" });
    expect(ok.body).toMatchObject({ stage: "broken_down", available_outcomes: [] });
  });

  it("refuses next on a scheduled node, and shows it no outcomes", async () => {
    const node = await h.create("nightly", { cron: "0 0 * * *" });
    expect(node.available_outcomes).toEqual([]);
    const res = await h.post(node.id, "next", { outcome: "fire" });
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toContain("scheduled");
    expect((await h.node(node.id)).stage).toBe("scheduled");
  });

  it("needs a cron to enter a scheduled type", async () => {
    const node = await h.create("hotfix");
    const res = await h.post(node.id, "next", { outcome: "to_nightly" });
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toContain("cron");
    expect((await h.node(node.id)).type).toBe("hotfix");
  });

  it("takes no reason", async () => {
    const node = await h.create("triage");
    expect((await h.post(node.id, "next", { outcome: "ready", reason: "x" })).status).toBe(400);
  });
});

describe("human move", () => {
  it("moves to any stage in the type, ignoring next", async () => {
    const node = await h.create("dev");
    const res = await h.post(node.id, "move", { stage: "pr_review" });
    expect(res.body).toMatchObject({ stage: "pr_review", type: "dev" });
    expect((await stageEvents(node.id))[0]).toMatchObject({ via: "move" });
    const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
    expect(events.body.at(-1)?.actor).toBe("human");
  });

  it("switches type when the stage is only in another type", async () => {
    const node = await h.create("triage");
    expect((await h.post(node.id, "move", { stage: "spec_review" })).body).toMatchObject({
      stage: "spec_review",
      type: "dev",
    });
  });

  it("needs a type when the stage is in several other types", async () => {
    const node = await h.create("triage");
    const res = await h.post(node.id, "move", { stage: "implement" });
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toContain("dev, hotfix");
    expect((await h.post(node.id, "move", { stage: "implement", type: "hotfix" })).body.type).toBe("hotfix");
    expect((await h.post(node.id, "move", { stage: "write_spec", type: "hotfix" })).status).toBe(400);
    expect((await h.post(node.id, "move", { stage: "write_spec", type: "nope" })).status).toBe(400);
  });

  it("moves to done, and refuses an unknown stage", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "move", { stage: "nope" })).status).toBe(400);
    expect((await h.post(node.id, "move", { stage: "done" })).body.stage).toBe("done");
    expect((await h.post(node.id, "move", { stage: "write_spec" })).body.stage).toBe("write_spec");
  });

  it("refuses broken_down without children", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "move", { stage: "broken_down" })).status).toBe(409);
    await child(node.id);
    expect((await h.post(node.id, "move", { stage: "broken_down" })).body.stage).toBe("broken_down");
  });

  it("moves to scheduled with a cron", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "move", { stage: "scheduled" })).status).toBe(409);
    expect((await h.post(node.id, "move", { stage: "scheduled", cron: "nope" })).status).toBe(400);
    expect((await h.post(node.id, "move", { stage: "implement", cron: "0 0 * * *" })).status).toBe(400);
    const res = await h.post(node.id, "move", { stage: "scheduled", cron: "0 0 * * *" });
    expect(res.body).toMatchObject({ stage: "scheduled", type: "nightly", cron: "0 0 * * *" });
  });

  it("sends stages with their own required state to their own actions", async () => {
    const node = await h.create("dev");
    for (const stage of ["invalidated", "ask_human_question", "failed"]) {
      const res = await h.post(node.id, "move", { stage });
      expect(res.status).toBe(400);
      expect(errorOf(res).message).toContain("Use the");
    }
  });

  it("takes a node out of failed, clearing return_stage", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "fail");
    const res = await h.post(node.id, "move", { stage: "spec_review" });
    expect(res.body).toMatchObject({ stage: "spec_review", return_stage: null });
  });

  it("takes a node out of invalidated, clearing the reason", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "invalidate", { reason: "x" });
    const res = await h.post(node.id, "move", { stage: "implement" });
    expect(res.body).toMatchObject({ stage: "implement", invalidation_reason: null });
  });
});

describe("stages removed from stages.yaml", () => {
  const dropImplement = () =>
    h.rewriteStages(`
start: dev
stages:
  write_spec: { turn: agent, prompt: ./prompts/write_spec.md }
  pr_review: { turn: human }
types:
  dev:
    start: write_spec
    stages:
      write_spec: { next: { done: pr_review } }
      pr_review: { next: { merged: done } }
`);

  it("flags the node and refuses next until a human moves it", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "move", { stage: "implement" });
    dropImplement();

    const flagged = await h.node(node.id);
    expect(flagged).toMatchObject({ stage: "implement", stage_exists: false, turn: null, available_outcomes: [] });
    const list = await h.call<NodeView[]>("GET", `/api/projects/${h.projectId}/nodes`);
    expect(list.body[0]?.stage_exists).toBe(false);

    const res = await h.post(node.id, "next", { outcome: "pr_raised" });
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toContain("human must move");
    expect((await h.post(node.id, "ask", { question: "?" })).status).toBe(409);
    expect((await h.post(node.id, "fail")).status).toBe(409);

    const moved = await h.post(node.id, "move", { stage: "pr_review" });
    expect(moved.body).toMatchObject({ stage: "pr_review", stage_exists: true });
  });

  it("refuses answer, retry and restore into a removed stage, leaving move as the way out", async () => {
    const asked = await h.create("dev");
    await h.post(asked.id, "move", { stage: "implement" });
    await h.post(asked.id, "ask", { question: "?" });
    const failed = await h.create("dev");
    await h.post(failed.id, "move", { stage: "implement" });
    await h.post(failed.id, "fail");
    const invalid = await h.create("dev");
    await h.post(invalid.id, "move", { stage: "implement" });
    await h.post(invalid.id, "invalidate", { reason: "x" });

    dropImplement();

    for (const [id, action, body] of [
      [asked.id, "answer", { answer: "a" }],
      [failed.id, "retry", {}],
      [invalid.id, "restore", {}],
    ] as const) {
      const res = await h.post(id, action, body);
      expect(res.status).toBe(409);
      expect(errorOf(res).message).toContain("no longer exists");
      expect((await h.post(id, "move", { stage: "write_spec" })).body.stage).toBe("write_spec");
    }
    const messages = await h.call<unknown[]>("GET", `/api/nodes/${asked.id}/messages`);
    expect(messages.body).toHaveLength(1);
  });

  it("flags a node whose type was removed, and lets a move land in a live type", async () => {
    const node = await h.create("triage");
    dropImplement();
    expect(await h.node(node.id)).toMatchObject({ stage_exists: false, available_outcomes: [] });
    const res = await h.post(node.id, "move", { stage: "write_spec" });
    expect(res.body).toMatchObject({ type: "dev", stage: "write_spec", stage_exists: true });
  });

  it("reports an invalid stages.yaml instead of acting on it", async () => {
    const node = await h.create("dev");
    h.rewriteStages("stages: { broken: { turn: agent } }\ntypes: {}\n");
    const res = await h.post(node.id, "next", { outcome: "done" });
    expect(res.status).toBe(422);
    expect(errorOf(res).details).toContain('stage "broken": agent stage has no prompt');
    h.rewriteStages(STAGES_YAML);
    expect((await h.post(node.id, "next", { outcome: "done" })).status).toBe(200);
  });
});

describe("ask and answer", () => {
  it("moves to ask_human_question, posts the question, and returns on answer", async () => {
    const node = await h.create("dev");
    const asked = await h.post(node.id, "ask", { question: "Which DB?" });
    expect(asked.body).toMatchObject({
      stage: "ask_human_question",
      return_stage: "write_spec",
      turn: "human",
      available_outcomes: [],
    });
    const answered = await h.post(node.id, "answer", { answer: "SQLite" });
    expect(answered.body).toMatchObject({ stage: "write_spec", return_stage: null, type: "dev" });

    const messages = await h.call<{ author: string; body: string; stage: string }[]>(
      "GET",
      `/api/nodes/${node.id}/messages`,
    );
    expect(messages.body.map((m) => [m.author, m.body, m.stage])).toEqual([
      ["agent", "Which DB?", "ask_human_question"],
      ["human", "SQLite", "ask_human_question"],
    ]);
    const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
    expect(events.body.map((e) => e.kind)).toEqual([
      "node_created",
      "stage_changed",
      "message_added",
      "message_added",
      "stage_changed",
    ]);
  });

  it("only asks from an agent stage", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "next", { outcome: "done" });
    const human = await h.post(node.id, "ask", { question: "?" });
    expect(human.status).toBe(409);
    expect(errorOf(human).message).toContain("not an agent stage");

    const scheduled = await h.create("nightly", { cron: "0 0 * * *" });
    expect((await h.post(scheduled.id, "ask", { question: "?" })).status).toBe(409);
    await h.post(node.id, "move", { stage: "done" });
    expect((await h.post(node.id, "ask", { question: "?" })).status).toBe(409);
  });

  it("can't ask twice, and can't answer unless waiting on one", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "answer", { answer: "a" })).status).toBe(409);
    await h.post(node.id, "ask", { question: "?" });
    expect((await h.post(node.id, "ask", { question: "again?" })).status).toBe(409);
    expect((await h.post(node.id, "next", { outcome: "done" })).status).toBe(409);
  });

  it("requires a question and an answer", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "ask", {})).status).toBe(400);
    expect((await h.post(node.id, "ask", { question: "  " })).status).toBe(400);
    await h.post(node.id, "ask", { question: "?" });
    expect((await h.post(node.id, "answer", { answer: "" })).status).toBe(400);
    expect((await h.node(node.id)).stage).toBe("ask_human_question");
  });
});

describe("fail and retry", () => {
  it("moves to failed and retry returns to the same stage", async () => {
    const node = await h.create("dev");
    const failed = await h.post(node.id, "fail", { reason: "exit 1" });
    expect(failed.body).toMatchObject({ stage: "failed", return_stage: "write_spec", turn: "human" });
    expect((await stageEvents(node.id))[0]).toMatchObject({ via: "fail", reason: "exit 1" });
    const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
    expect(events.body.at(-1)?.actor).toBe("system");

    const retried = await h.post(node.id, "retry");
    expect(retried.body).toMatchObject({ stage: "write_spec", return_stage: null });
  });

  it("only fails an agent stage and only retries a failed node", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "retry")).status).toBe(409);
    await h.post(node.id, "next", { outcome: "done" });
    expect((await h.post(node.id, "fail")).status).toBe(409);
  });

  it("refuses a human marking a node failed, which only AOP does", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "fail", { actor: "human" })).status).toBe(409);
    expect((await h.node(node.id)).stage).toBe("write_spec");
  });

  it("refuses next while failed", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "fail");
    expect((await h.post(node.id, "next", { outcome: "done" })).status).toBe(409);
  });
});

describe("invalidate and restore", () => {
  it("requires a reason", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "invalidate", {})).status).toBe(400);
    expect((await h.post(node.id, "invalidate", { reason: " " })).status).toBe(400);
    expect((await h.node(node.id)).stage).toBe("write_spec");
  });

  it("is human-only, so an agent can't invalidate", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "invalidate", { reason: "x", actor: "agent" })).status).toBe(409);
    expect((await h.post(node.id, "invalidate", { reason: "x", actor: "system" })).status).toBe(409);
    expect((await h.node(node.id)).stage).toBe("write_spec");
  });

  it("restores the stage and type from events", async () => {
    const node = await h.create("triage");
    await h.post(node.id, "next", { outcome: "ready" });
    await h.post(node.id, "next", { outcome: "done" });
    const invalid = await h.post(node.id, "invalidate", { reason: "Wrong idea" });
    expect(invalid.body).toMatchObject({
      stage: "invalidated",
      invalidation_reason: "Wrong idea",
      available_outcomes: [],
    });
    const restored = await h.post(node.id, "restore");
    expect(restored.body).toMatchObject({ stage: "spec_review", type: "dev", invalidation_reason: null });
  });

  it("restores across a node invalidated more than once, using the latest", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "invalidate", { reason: "a" });
    await h.post(node.id, "restore");
    await h.post(node.id, "next", { outcome: "done" });
    await h.post(node.id, "invalidate", { reason: "b" });
    expect((await h.post(node.id, "restore")).body.stage).toBe("spec_review");
  });

  it("restores a waiting node with its return_stage", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "ask", { question: "?" });
    await h.post(node.id, "invalidate", { reason: "x" });
    const restored = await h.post(node.id, "restore");
    expect(restored.body).toMatchObject({ stage: "ask_human_question", return_stage: "write_spec" });
    expect((await h.post(node.id, "answer", { answer: "a" })).body.stage).toBe("write_spec");
  });

  it("restores a scheduled node with its cron", async () => {
    const node = await h.create("nightly", { cron: "0 0 * * *" });
    await h.post(node.id, "invalidate", { reason: "x" });
    expect((await h.post(node.id, "restore")).body).toMatchObject({ stage: "scheduled", cron: "0 0 * * *" });
  });

  it("can invalidate a terminal node", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "move", { stage: "done" });
    expect((await h.post(node.id, "invalidate", { reason: "x" })).status).toBe(200);
    expect((await h.post(node.id, "restore")).body.stage).toBe("done");
  });

  it("refuses to invalidate twice or restore a node that isn't invalidated", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "restore")).status).toBe(409);
    await h.post(node.id, "invalidate", { reason: "x" });
    expect((await h.post(node.id, "invalidate", { reason: "y" })).status).toBe(409);
  });

  it("derives invalidated by parent for all descendants through subtask edges, without writing it", async () => {
    const root = await h.create("triage");
    const mid = await child(root.id);
    const leaf = await child(mid.id);
    const blocked = await h.create("dev");
    await h.call("POST", `/api/nodes/${root.id}/edges`, { target_id: blocked.id, kind: "blocks" });

    const before = h.db.prepare("SELECT * FROM nodes WHERE id = ?").get(leaf.id);
    await h.post(root.id, "invalidate", { reason: "x" });
    expect(h.db.prepare("SELECT * FROM nodes WHERE id = ?").get(leaf.id)).toEqual(before);

    expect(await h.node(mid.id)).toMatchObject({ invalidated_by_parent: true, invalidated_ancestors: [root.id] });
    expect(await h.node(leaf.id)).toMatchObject({ invalidated_by_parent: true, invalidated_ancestors: [root.id], stage: "write_spec" });
    expect((await h.node(root.id)).invalidated_by_parent).toBe(false);
    expect((await h.node(blocked.id)).invalidated_by_parent).toBe(false);

    await h.post(root.id, "restore");
    expect((await h.node(leaf.id)).invalidated_by_parent).toBe(false);
  });

  it("stops being invalidated by parent when the subtask edge is removed, and survives cycles", async () => {
    const a = await h.create("dev");
    const b = await child(a.id);
    const edge = await h.call<{ id: string }>("POST", `/api/nodes/${b.id}/edges`, { target_id: a.id, kind: "subtask" });
    await h.post(a.id, "invalidate", { reason: "x" });
    expect(await h.node(b.id)).toMatchObject({ invalidated_by_parent: true });
    expect(await h.node(a.id)).toMatchObject({ invalidated_by_parent: false });
    const edges = await h.call<{ id: string; source_id: string }[]>("GET", `/api/nodes/${b.id}/edges`);
    await h.call("DELETE", `/api/edges/${edges.body.find((e) => e.source_id === a.id)?.id}`);
    expect(edge.status).toBe(201);
    expect((await h.node(b.id)).invalidated_by_parent).toBe(false);
  });
});

describe("messages", () => {
  it("adds at the current stage and lists", async () => {
    const node = await h.create("dev");
    const res = await h.call("POST", `/api/nodes/${node.id}/messages`, { body: "Note", author: "agent" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ body: "Note", author: "agent", stage: "write_spec" });
    const list = await h.call<unknown[]>("GET", `/api/nodes/${node.id}/messages`);
    expect(list.body).toHaveLength(1);
    const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
    expect(events.body.at(-1)).toMatchObject({ kind: "message_added", actor: "agent" });
  });

  it("refuses a blank body, a bad author and a missing node", async () => {
    const node = await h.create("dev");
    const path = `/api/nodes/${node.id}/messages`;
    expect((await h.call("POST", path, { body: "" })).status).toBe(400);
    expect((await h.call("POST", path, { body: " \n" })).status).toBe(400);
    expect((await h.call("POST", path, { body: "x", author: "robot" })).status).toBe(400);
    expect((await h.call("POST", "/api/nodes/missing/messages", { body: "x" })).status).toBe(404);
  });
});

describe("links", () => {
  it("adds and lists, recording an event", async () => {
    const node = await h.create("dev");
    const path = `/api/nodes/${node.id}/links`;
    const res = await h.call("POST", path, { kind: "pr", url: "https://example.com/pr/1" });
    expect(res.status).toBe(201);
    await h.call("POST", path, { kind: "ticket", url: "http://example.com/t/1" });
    expect((await h.call<unknown[]>("GET", path)).body).toHaveLength(2);
    const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
    expect(events.body.at(-1)?.kind).toBe("link_added");
  });

  it("checks the URL and the kind", async () => {
    const node = await h.create("dev");
    const path = `/api/nodes/${node.id}/links`;
    for (const url of ["javascript:alert(1)", "ftp://x", "example.com", "http://", " https://x"]) {
      expect((await h.call("POST", path, { kind: "pr", url })).status).toBe(400);
    }
    expect((await h.call("POST", path, { kind: "doc", url: "https://x" })).status).toBe(400);
  });

  it("refuses a duplicate on the same node, without writing an event", async () => {
    const node = await h.create("dev");
    const path = `/api/nodes/${node.id}/links`;
    await h.call("POST", path, { kind: "pr", url: "https://x" });
    const count = (await h.call<unknown[]>("GET", `/api/nodes/${node.id}/events`)).body.length;
    const res = await h.call("POST", path, { kind: "pr", url: "https://x" });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("constraint_violation");
    expect((await h.call<unknown[]>("GET", `/api/nodes/${node.id}/events`)).body).toHaveLength(count);
  });
});

describe("edges", () => {
  it("adds, lists in both directions, and removes by setting removed_at", async () => {
    const a = await h.create("dev");
    const b = await h.create("dev");
    const added = await h.call<{ id: string }>("POST", `/api/nodes/${a.id}/edges`, {
      target_id: b.id,
      kind: "blocks",
    });
    expect(added.status).toBe(201);
    expect((await h.call<unknown[]>("GET", `/api/nodes/${a.id}/edges`)).body).toHaveLength(1);
    expect((await h.call<unknown[]>("GET", `/api/nodes/${b.id}/edges`)).body).toHaveLength(1);

    const removed = await h.call("DELETE", `/api/edges/${added.body.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body["removed_at"]).toEqual(expect.any(String));
    expect((await h.call<unknown[]>("GET", `/api/nodes/${a.id}/edges`)).body).toHaveLength(0);
    expect((await h.call<unknown[]>("GET", `/api/nodes/${a.id}/edges?include_removed=true`)).body).toHaveLength(1);
    expect(h.db.prepare("SELECT count(*) AS n FROM edges").get()).toEqual({ n: 1 });

    expect((await h.call("DELETE", `/api/edges/${added.body.id}`)).status).toBe(409);
    expect((await h.call("DELETE", "/api/edges/missing")).status).toBe(404);

    const events = await h.call<EventView[]>("GET", `/api/nodes/${a.id}/events`);
    expect(events.body.map((e) => e.kind)).toEqual(["node_created", "edge_added", "edge_removed"]);
  });

  it("refuses a self edge, a duplicate, a bad kind and a missing node", async () => {
    const a = await h.create("dev");
    const b = await h.create("dev");
    const path = `/api/nodes/${a.id}/edges`;
    expect((await h.call("POST", path, { target_id: a.id, kind: "blocks" })).status).toBe(409);
    await h.call("POST", path, { target_id: b.id, kind: "blocks" });
    expect((await h.call("POST", path, { target_id: b.id, kind: "blocks" })).status).toBe(409);
    expect((await h.call("POST", path, { target_id: b.id, kind: "parent" })).status).toBe(400);
    expect((await h.call("POST", path, { target_id: "missing", kind: "blocks" })).status).toBe(404);
  });

  it("refuses an edge across projects", async () => {
    const other = await h.call<{ id: string }>("POST", "/api/projects", { repo_path: makeRepo() });
    const foreign = await h.call<NodeView>("POST", `/api/projects/${other.body.id}/nodes`, { type: "dev", title: "x" });
    const a = await h.create("dev");
    const res = await h.call("POST", `/api/nodes/${a.id}/edges`, { target_id: foreign.body.id, kind: "blocks" });
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toContain("share a project");
  });
});

describe("blocks helper", () => {
  it("holds a node until its blocker is done, and a broken_down one doesn't count", async () => {
    const blocker = await h.create("dev");
    const held = await h.create("dev");
    const edge = await h.call<{ id: string }>("POST", `/api/nodes/${blocker.id}/edges`, {
      target_id: held.id,
      kind: "blocks",
    });

    expect(holdersOf(h.db, held.id)).toEqual([{ id: blocker.id, stage: "write_spec", via: "blocks" }]);
    expect((await h.node(held.id)).blocked_by).toEqual([blocker.id]);
    expect(holdersOf(h.db, blocker.id)).toEqual([]);

    await h.post(blocker.id, "move", { stage: "done" });
    expect(holdersOf(h.db, held.id)).toEqual([]);

    await h.post(blocker.id, "move", { stage: "write_spec" });
    expect(holdersOf(h.db, held.id)).toHaveLength(1);

    await child(blocker.id);
    await h.post(blocker.id, "move", { stage: "broken_down" });
    expect(holdersOf(h.db, held.id)).toEqual([{ id: blocker.id, stage: "broken_down", via: "blocks" }]);

    await h.post(blocker.id, "move", { stage: "write_spec" });
    await h.call("DELETE", `/api/edges/${edge.body.id}`);
    expect(holdersOf(h.db, held.id)).toEqual([]);
  });

  it("keeps holding when the blocker is invalidated", async () => {
    const blocker = await h.create("dev");
    const held = await h.create("dev");
    await h.call("POST", `/api/nodes/${blocker.id}/edges`, { target_id: held.id, kind: "blocks" });
    await h.post(blocker.id, "invalidate", { reason: "x" });
    expect(holdersOf(h.db, held.id)).toEqual([{ id: blocker.id, stage: "invalidated", via: "blocks" }]);
  });

  it("ignores subtask edges", async () => {
    const parent = await h.create("dev");
    const kid = await child(parent.id);
    expect(holdersOf(h.db, kid.id)).toEqual([]);
  });
});

describe("events", () => {
  it("rolls the change back if its event can't be written", async () => {
    const node = await h.create("dev");
    h.db.exec(`CREATE TRIGGER test_no_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'no events'); END`);
    const res = await h.post(node.id, "next", { outcome: "done" });
    expect(res.status).toBe(409);
    const asked = await h.post(node.id, "ask", { question: "?" });
    expect(asked.status).toBe(409);
    h.db.exec("DROP TRIGGER test_no_events");

    expect((await h.node(node.id)).stage).toBe("write_spec");
    expect((await h.call<unknown[]>("GET", `/api/nodes/${node.id}/messages`)).body).toEqual([]);
  });

  it("rolls the stage change back if the question can't be stored", async () => {
    const node = await h.create("dev");
    h.db.exec(`CREATE TRIGGER test_no_messages BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END`);
    expect((await h.post(node.id, "ask", { question: "?" })).status).toBe(409);
    h.db.exec("DROP TRIGGER test_no_messages");
    expect((await h.node(node.id)).stage).toBe("write_spec");
    expect(await stageEvents(node.id)).toEqual([]);
  });

  it("records the actor sent with a request, and 404s for a missing node", async () => {
    const node = await h.create("dev", { actor: "agent" });
    const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
    expect(events.body[0]?.actor).toBe("agent");
    expect((await h.call("GET", "/api/nodes/missing/events")).status).toBe(404);
  });
});

describe("routing", () => {
  it("answers unknown routes with a JSON 404", async () => {
    const res = await h.call("GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("not_found");
  });

  it("rejects a body that isn't JSON", async () => {
    const node = await h.create("dev");
    const { createApp } = await import("../../src/server/api.js");
    const res = await createApp(h.db).request(`/api/nodes/${node.id}/next`, {
      method: "POST",
      headers: { host: "localhost" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
