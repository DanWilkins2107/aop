import { beforeEach, describe, expect, it } from "vitest";
import { holdersOf, type EventView, type MessageRow, type NodeView } from "../../src/server/nodes.js";
import { harness, STAGES_YAML, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(() => {
  h = harness();
});

async function eventsOf(nodeId: string): Promise<EventView[]> {
  return (await h.call<EventView[]>("GET", `/api/nodes/${nodeId}/events`)).body;
}

async function messagesOf(nodeId: string): Promise<MessageRow[]> {
  return (await h.call<MessageRow[]>("GET", `/api/nodes/${nodeId}/messages`)).body;
}

async function childOf(parent: string): Promise<NodeView> {
  const node = await h.create("dev");
  const res = await h.call("POST", `/api/nodes/${parent}/edges`, { target_id: node.id, kind: "subtask" });
  expect(res.status).toBe(201);
  return node;
}

const edge = (source: string, target: string, kind = "blocks") =>
  h.call("POST", `/api/nodes/${source}/edges`, { target_id: target, kind });

/** A triage node at `split_approved`, the agent stage that begins a split in these tests. */
async function atSplitApproved(): Promise<NodeView> {
  const node = await h.create("triage");
  await h.post(node.id, "next", { outcome: "split" });
  return (await h.post(node.id, "next", { outcome: "approve" })).body;
}

async function splitting(): Promise<NodeView> {
  const node = await atSplitApproved();
  return (await h.post(node.id, "split/start")).body;
}

describe("creating nodes in the right place", () => {
  const path = () => `/api/projects/${h.projectId}/nodes`;

  it("defaults to the top-level start type", async () => {
    const res = await h.call<NodeView>("POST", path(), { title: "x" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "triage", stage: "awaiting_agent_breakdown" });
  });

  it("can choose a type, entering at its start", async () => {
    const res = await h.call<NodeView>("POST", path(), { title: "x", type: "dev" });
    expect(res.body).toMatchObject({ type: "dev", stage: "write_spec" });
  });

  it("can choose a stage, finding its type as a move does", async () => {
    const res = await h.call<NodeView>("POST", path(), { title: "x", stage: "pr_review" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "dev", stage: "pr_review", turn: "human" });
    const events = await eventsOf(res.body.id);
    expect(events[0]?.data).toMatchObject({ type: "dev", stage: "pr_review" });
  });

  it("prefers the start type for a stage it lists, and asks which when a stage is ambiguous", async () => {
    const own = await h.call<NodeView>("POST", path(), { title: "x", stage: "split_proposed" });
    expect(own.body.type).toBe("triage");
    // `implement` is in dev and hotfix, neither of them the start type.
    expect((await h.call("POST", path(), { title: "x", stage: "implement" })).status).toBe(400);
    const chosen = await h.call<NodeView>("POST", path(), { title: "x", stage: "implement", type: "hotfix" });
    expect(chosen.body).toMatchObject({ type: "hotfix", stage: "implement" });
  });

  it("refuses an unknown type or stage, and a stage outside the chosen type", async () => {
    expect((await h.call("POST", path(), { title: "x", type: "nope" })).status).toBe(400);
    expect((await h.call("POST", path(), { title: "x", stage: "nope" })).status).toBe(400);
    expect((await h.call("POST", path(), { title: "x", stage: "awaiting_agent_breakdown", type: "dev" })).status).toBe(400);
  });

  it("refuses built-ins that need their own action or state", async () => {
    for (const stage of ["invalidated", "ask_human_question", "failed", "externally_blocked", "splitting"]) {
      expect((await h.call("POST", path(), { title: "x", stage })).status).toBe(400);
    }
    expect((await h.call("POST", path(), { title: "x", stage: "broken_down" })).status).toBe(409);
  });

  it("requires a cron to start at scheduled by stage, and only then", async () => {
    expect((await h.call("POST", path(), { title: "x", stage: "scheduled" })).status).toBe(400);
    const res = await h.call<NodeView>("POST", path(), { title: "x", stage: "scheduled", cron: "0 0 * * *" });
    expect(res.body).toMatchObject({ type: "nightly", stage: "scheduled" });
    expect((await h.call("POST", path(), { title: "x", stage: "awaiting_agent_breakdown", cron: "0 0 * * *" })).status).toBe(400);
  });

  it("reports the start in the stages view", async () => {
    const res = await h.call("GET", "/api/stages");
    expect(res.body["start"]).toBe("triage");
  });
});

describe("externally_blocked", () => {
  it("requires a reason, posts it as a message and records where it came from", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "block", {})).status).toBe(400);
    expect((await h.post(node.id, "block", { reason: "  " })).status).toBe(400);

    const res = await h.post(node.id, "block", { reason: "Waiting on legal" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stage: "externally_blocked", return_stage: "write_spec", turn: "human", available_outcomes: [] });
    const [message] = await messagesOf(node.id);
    expect(message).toMatchObject({ body: "Waiting on legal", author: "human", stage: "externally_blocked" });
  });

  it("is human-only, both ways", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "block", { reason: "x", actor: "agent" })).status).toBe(409);
    await h.post(node.id, "block", { reason: "x" });
    expect((await h.post(node.id, "unblock", { actor: "agent" })).status).toBe(409);
    expect((await h.node(node.id)).stage).toBe("externally_blocked");
  });

  it("unblocks to where it was", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "next", { outcome: "done" });
    await h.post(node.id, "block", { reason: "x" });
    const res = await h.post(node.id, "unblock");
    expect(res.body).toMatchObject({ stage: "spec_review", return_stage: null });
    expect((await eventsOf(node.id)).at(-1)?.data).toMatchObject({ via: "unblock", to_stage: "spec_review" });
  });

  it("can't be entered from a finished stage or twice, and only a blocked node unblocks", async () => {
    const done = await h.create("dev");
    await h.call("POST", `/api/nodes/${done.id}/move`, { stage: "done" });
    expect((await h.post(done.id, "block", { reason: "x" })).status).toBe(409);

    const parent = await h.create("dev");
    await childOf(parent.id);
    await h.call("POST", `/api/nodes/${parent.id}/move`, { stage: "broken_down" });
    expect((await h.post(parent.id, "block", { reason: "x" })).status).toBe(409);

    const invalid = await h.create("dev");
    await h.post(invalid.id, "invalidate", { reason: "x" });
    expect((await h.post(invalid.id, "block", { reason: "x" })).status).toBe(409);

    const node = await h.create("dev");
    expect((await h.post(node.id, "unblock")).status).toBe(409);
    await h.post(node.id, "block", { reason: "x" });
    expect((await h.post(node.id, "block", { reason: "y" })).status).toBe(409);
  });

  it("keeps a question's return_stage when blocked from it", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "ask", { question: "Q?" });
    const blocked = await h.post(node.id, "block", { reason: "x" });
    expect(blocked.body.return_stage).toBe("ask_human_question");
    const back = await h.post(node.id, "unblock");
    expect(back.body).toMatchObject({ stage: "ask_human_question", return_stage: "write_spec" });
    expect((await h.post(node.id, "answer", { answer: "A" })).body.stage).toBe("write_spec");
  });

  it("survives invalidate and restore, still unblocking to the right place", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "block", { reason: "x" });
    await h.post(node.id, "invalidate", { reason: "y" });
    const restored = await h.post(node.id, "restore");
    expect(restored.body).toMatchObject({ stage: "externally_blocked", return_stage: "write_spec" });
    expect((await h.post(node.id, "unblock")).body.stage).toBe("write_spec");
  });

  it("counts as unfinished for blocks", async () => {
    const blocker = await h.create("dev");
    const held = await h.create("dev");
    await edge(blocker.id, held.id);
    await h.post(blocker.id, "block", { reason: "x" });
    expect((await h.node(held.id)).blocked_by).toEqual([blocker.id]);
    expect(holdersOf(h.db, held.id)).toEqual([{ id: blocker.id, stage: "externally_blocked", via: "blocks" }]);
  });

  it("refuses next, ask and fail, and move is the only other way out", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "block", { reason: "x" });
    expect((await h.post(node.id, "next", { outcome: "done" })).status).toBe(409);
    expect((await h.post(node.id, "next", { outcome: "done", actor: "agent" })).status).toBe(409);
    expect((await h.post(node.id, "ask", { question: "Q?" })).status).toBe(409);
    expect((await h.post(node.id, "fail")).status).toBe(409);
    const moved = await h.post(node.id, "move", { stage: "pr_review" });
    expect(moved.body).toMatchObject({ stage: "pr_review", return_stage: null });
  });

  it("can't be entered by a move", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "move", { stage: "externally_blocked" })).status).toBe(400);
  });

  it("refuses unblock into a stage since removed", async () => {
    const node = await h.create("hotfix");
    await h.post(node.id, "block", { reason: "x" });
    h.rewriteStages(STAGES_YAML.replace("      implement:   { next: { fixed: done, to_nightly: nightly } }\n", "      other:   { next: {} }\n")
      .replace("start: implement\n    stages:\n      other", "start: other\n    stages:\n      other")
      .replace("  pr_review:   { turn: human, color: \"#9775fa\" }\n", "  pr_review:   { turn: human, color: \"#9775fa\" }\n  other: { turn: human }\n"));
    expect((await h.post(node.id, "unblock")).status).toBe(409);
  });
});

describe("splitting", () => {
  it("starts only from an agent stage, recording that stage", async () => {
    const human = await h.create("triage");
    await h.post(human.id, "next", { outcome: "split" });
    expect((await h.post(human.id, "split/start")).status).toBe(409);

    const node = await splitting();
    expect(node).toMatchObject({ stage: "splitting", return_stage: "split_approved", turn: "agent", available_outcomes: [] });
    expect((await h.post(node.id, "split/start")).status).toBe(409);
    expect((await eventsOf(node.id)).at(-1)).toMatchObject({
      actor: "agent",
      data: { via: "split_start", from_stage: "split_approved", to_stage: "splitting" },
    });
  });

  it("refuses to finish without children or off splitting, and finishes to broken_down", async () => {
    const other = await atSplitApproved();
    expect((await h.post(other.id, "split/finish")).status).toBe(409);

    const node = await splitting();
    expect((await h.post(node.id, "split/finish")).status).toBe(409);
    expect((await h.node(node.id)).stage).toBe("splitting");

    await childOf(node.id);
    const finished = await h.post(node.id, "split/finish");
    expect(finished.body).toMatchObject({ stage: "broken_down", return_stage: null });
  });

  it("doesn't count a removed child", async () => {
    const node = await splitting();
    const created = await h.create("dev");
    const added = await edge(node.id, created.id, "subtask");
    await h.call("DELETE", `/api/edges/${added.body["id"]}`);
    expect((await h.post(node.id, "split/finish")).status).toBe(409);
  });

  it("can't be entered by a move, but can be left by one", async () => {
    const start = await h.create("dev");
    expect((await h.post(start.id, "move", { stage: "splitting" })).status).toBe(400);
    const node = await splitting();
    expect((await h.post(node.id, "move", { stage: "awaiting_agent_breakdown" })).body).toMatchObject({ stage: "awaiting_agent_breakdown", return_stage: null });
  });

  it("holds children only while the parent is splitting, and releases them together", async () => {
    const node = await splitting();
    const a = await childOf(node.id);
    const b = await childOf(node.id);
    expect(await h.node(a.id)).toMatchObject({ held: true, held_by: [node.id] });
    expect(await h.node(b.id)).toMatchObject({ held: true, held_by: [node.id] });
    expect(holdersOf(h.db, a.id)).toEqual([{ id: node.id, stage: "splitting", via: "split" }]);
    // Being held isn't being blocked.
    expect((await h.node(a.id)).blocked_by).toEqual([]);

    await h.post(node.id, "split/finish");
    expect(await h.node(a.id)).toMatchObject({ held: false, held_by: [] });
    expect((await h.node(b.id)).held).toBe(false);
    expect(holdersOf(h.db, a.id)).toEqual([]);
  });

  it("only holds direct children, through active subtask edges", async () => {
    const node = await splitting();
    const child = await childOf(node.id);
    const grandchild = await childOf(child.id);
    expect((await h.node(grandchild.id)).held).toBe(false);

    const blocked = await h.create("dev");
    await edge(node.id, blocked.id, "blocks");
    expect((await h.node(blocked.id)).held).toBe(false);

    const removed = await h.create("dev");
    const added = await edge(node.id, removed.id, "subtask");
    expect((await h.node(removed.id)).held).toBe(true);
    await h.call("DELETE", `/api/edges/${added.body["id"]}`);
    expect((await h.node(removed.id)).held).toBe(false);
  });

  it("holds children through a question, and the answer goes back to splitting", async () => {
    const node = await splitting();
    const child = await childOf(node.id);
    const asked = await h.post(node.id, "ask", { question: "Q?" });
    expect(asked.body).toMatchObject({ stage: "ask_human_question", return_stage: "splitting" });
    expect((await h.node(child.id)).held).toBe(true);

    const answered = await h.post(node.id, "answer", { answer: "A" });
    expect(answered.body).toMatchObject({ stage: "splitting", return_stage: "split_approved" });
    expect((await h.node(child.id)).held).toBe(true);
    expect((await h.post(node.id, "split/finish")).body.stage).toBe("broken_down");
  });

  it("holds children through a failure, and a retry goes back to splitting", async () => {
    const node = await splitting();
    const child = await childOf(node.id);
    const failed = await h.post(node.id, "fail");
    expect(failed.body).toMatchObject({ stage: "failed", return_stage: "splitting" });
    expect((await h.node(child.id)).held).toBe(true);

    const retried = await h.post(node.id, "retry");
    expect(retried.body).toMatchObject({ stage: "splitting", return_stage: "split_approved" });
    expect((await h.node(child.id)).held).toBe(true);
  });

  it("keeps holding through an external block, directly or from a question", async () => {
    const node = await splitting();
    const child = await childOf(node.id);
    await h.post(node.id, "block", { reason: "x" });
    expect((await h.node(child.id)).held).toBe(true);
    expect((await h.post(node.id, "unblock")).body).toMatchObject({ stage: "splitting", return_stage: "split_approved" });

    await h.post(node.id, "ask", { question: "Q?" });
    await h.post(node.id, "block", { reason: "y" });
    expect((await h.node(child.id)).held).toBe(true);
    expect((await h.post(node.id, "unblock")).body).toMatchObject({ stage: "ask_human_question", return_stage: "splitting" });
    expect((await h.post(node.id, "answer", { answer: "A" })).body).toMatchObject({ stage: "splitting", return_stage: "split_approved" });
  });

  it("doesn't hold for a question or an external block outside a split", async () => {
    const parent = await h.create("dev");
    const child = await childOf(parent.id);
    await h.post(parent.id, "ask", { question: "Q?" });
    expect((await h.node(child.id)).held).toBe(false);
    await h.post(parent.id, "block", { reason: "x" });
    expect((await h.node(child.id)).held).toBe(false);
  });

  it("releases children when a human moves the parent out of the split", async () => {
    const node = await splitting();
    const child = await childOf(node.id);
    await h.post(node.id, "ask", { question: "Q?" });
    await h.post(node.id, "move", { stage: "awaiting_agent_breakdown" });
    expect((await h.node(child.id)).held).toBe(false);
  });

  it("returns to splitting after invalidate and restore, holding again", async () => {
    const node = await splitting();
    const child = await childOf(node.id);
    await h.post(node.id, "invalidate", { reason: "x" });
    expect(await h.node(child.id)).toMatchObject({ held: false, invalidated_by_parent: true });
    const restored = await h.post(node.id, "restore");
    expect(restored.body).toMatchObject({ stage: "splitting", return_stage: "split_approved" });
    expect((await h.node(child.id)).held).toBe(true);
  });

  it("refuses an answer when the stage that began the split was removed", async () => {
    const node = await splitting();
    await h.post(node.id, "ask", { question: "Q?" });
    h.rewriteStages(`
start: triage
stages:
  awaiting_agent_breakdown: { turn: agent, prompt: ./prompts/awaiting_agent_breakdown.md }
types:
  triage: { start: awaiting_agent_breakdown, stages: { awaiting_agent_breakdown: { next: {} } } }
`);
    expect((await h.post(node.id, "answer", { answer: "A" })).status).toBe(409);
    expect((await h.node(node.id)).stage).toBe("ask_human_question");
  });

  it("refuses an unblock or a restore into splitting when the stage that began the split was removed", async () => {
    const blocked = await splitting();
    await h.post(blocked.id, "block", { reason: "x" });
    const invalidated = await splitting();
    await h.post(invalidated.id, "invalidate", { reason: "x" });
    h.rewriteStages(`
start: triage
stages:
  awaiting_agent_breakdown: { turn: agent, prompt: ./prompts/awaiting_agent_breakdown.md }
types:
  triage: { start: awaiting_agent_breakdown, stages: { awaiting_agent_breakdown: { next: {} } } }
`);
    const unblock = await h.post(blocked.id, "unblock");
    expect(unblock.status).toBe(409);
    expect(JSON.stringify(unblock.body)).toContain('\\"split_approved\\"');
    expect((await h.node(blocked.id)).stage).toBe("externally_blocked");
    expect((await h.post(invalidated.id, "restore")).status).toBe(409);
    expect((await h.node(invalidated.id)).stage).toBe("invalidated");
  });

  it("uses the latest split when a node splits twice", async () => {
    const node = await splitting();
    await h.post(node.id, "move", { stage: "implement", type: "hotfix" });
    await h.post(node.id, "split/start");
    await h.post(node.id, "ask", { question: "Q?" });
    expect((await h.post(node.id, "answer", { answer: "A" })).body.return_stage).toBe("implement");
  });
});

describe("a split's blocks move to its children", () => {
  /** A parent ready to finish its split, apart from any blocks edges a test adds. */
  async function splitWithChild(): Promise<{ node: NodeView; kid: NodeView }> {
    const node = await splitting();
    return { node, kid: await childOf(node.id) };
  }

  it("refuses split finish with a blocks edge in either direction, then allows it once removed", async () => {
    for (const outgoing of [true, false]) {
      const { node } = await splitWithChild();
      const other = await h.create("dev");
      const added = outgoing ? await edge(node.id, other.id) : await edge(other.id, node.id);
      const res = await h.post(node.id, "split/finish");
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain("Move them to the relevant children");
      expect((await h.node(node.id)).stage).toBe("splitting");

      await h.call("DELETE", `/api/edges/${added.body["id"]}`);
      expect((await h.post(node.id, "split/finish")).body.stage).toBe("broken_down");
    }
  });

  it("refuses next to broken_down with a blocks edge in either direction", async () => {
    for (const outgoing of [true, false]) {
      const node = await atSplitApproved();
      await childOf(node.id);
      const other = await h.create("dev");
      const added = outgoing ? await edge(node.id, other.id) : await edge(other.id, node.id);
      const res = await h.post(node.id, "next", { outcome: "done" });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain("Move them to the relevant children");

      await h.call("DELETE", `/api/edges/${added.body["id"]}`);
      expect((await h.post(node.id, "next", { outcome: "done" })).body.stage).toBe("broken_down");
    }
  });

  it("finishes once the block is on a child, and the child stays blocked", async () => {
    const { node, kid } = await splitWithChild();
    const other = await h.create("dev");
    const added = await edge(other.id, node.id);
    await h.call("DELETE", `/api/edges/${added.body["id"]}`);
    await edge(other.id, kid.id);
    expect((await h.post(node.id, "split/finish")).body.stage).toBe("broken_down");
    expect(await h.node(kid.id)).toMatchObject({ blocked_by: [other.id], held: false });
  });

  it("ignores subtask edges", async () => {
    const { node } = await splitWithChild();
    const parent = await h.create("dev");
    await edge(parent.id, node.id, "subtask");
    expect((await h.post(node.id, "split/finish")).status).toBe(200);
  });

  it("lets a human move to broken_down with blocks edges, as the escape hatch", async () => {
    const { node } = await splitWithChild();
    const other = await h.create("dev");
    await edge(node.id, other.id);
    expect((await h.post(node.id, "move", { stage: "broken_down" })).body.stage).toBe("broken_down");
  });

  it("skips the blocks check on a force move whichever way the edges point, keeping them", async () => {
    const { node } = await splitWithChild();
    const before = await h.create("dev");
    const after = await h.create("dev");
    await edge(before.id, node.id);
    await edge(node.id, after.id);
    expect((await h.post(node.id, "split/finish")).status).toBe(409);
    expect((await h.post(node.id, "move", { stage: "broken_down" })).body).toMatchObject({
      stage: "broken_down",
      blocked_by: [before.id],
    });
    expect((await h.node(after.id)).blocked_by).toEqual([node.id]);
  });

  it("keeps a broken_down blocker holding, because only done counts as finished", async () => {
    const { node } = await splitWithChild();
    const held = await h.create("dev");
    await edge(node.id, held.id);
    await h.post(node.id, "move", { stage: "broken_down" });
    expect((await h.node(held.id)).blocked_by).toEqual([node.id]);
    expect(holdersOf(h.db, held.id)).toEqual([{ id: node.id, stage: "broken_down", via: "blocks" }]);

    await h.post(node.id, "move", { stage: "done" });
    expect((await h.node(held.id)).blocked_by).toEqual([]);
  });

  it("refuses a new blocks edge to or from a broken_down node, but not a subtask edge", async () => {
    const { node } = await splitWithChild();
    await h.post(node.id, "split/finish");
    const other = await h.create("dev");
    for (const res of [await edge(node.id, other.id), await edge(other.id, node.id)]) {
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain("broken_down");
    }
    expect((await h.node(other.id)).blocked_by).toEqual([]);
    expect((await edge(node.id, other.id, "subtask")).status).toBe(201);
  });
});

describe("the helper reporting what holds a node", () => {
  it("reports blocks, a split and an invalidated parent together", async () => {
    const node = await splitting();
    const child = await childOf(node.id);
    const blocker = await h.create("dev");
    await edge(blocker.id, child.id);
    const invalid = await h.create("dev");
    await edge(invalid.id, child.id, "subtask");
    await h.post(invalid.id, "invalidate", { reason: "x" });

    expect(holdersOf(h.db, child.id)).toEqual(
      expect.arrayContaining([
        { id: blocker.id, stage: "write_spec", via: "blocks" },
        { id: node.id, stage: "splitting", via: "split" },
        { id: invalid.id, stage: "invalidated", via: "invalidated_parent" },
      ]),
    );
    expect(await h.node(child.id)).toMatchObject({
      blocked_by: [blocker.id],
      held_by: [node.id],
      invalidated_ancestors: [invalid.id],
    });
  });

  it("reaches through every ancestor for an invalidated parent", async () => {
    const root = await h.create("dev");
    const mid = await childOf(root.id);
    const leaf = await childOf(mid.id);
    await h.post(root.id, "invalidate", { reason: "x" });
    expect(holdersOf(h.db, leaf.id)).toEqual([{ id: root.id, stage: "invalidated", via: "invalidated_parent" }]);
    await h.post(root.id, "restore");
    expect(holdersOf(h.db, leaf.id)).toEqual([]);
  });
});

describe("claims", () => {
  it("starts unclaimed, and a human can claim and release", async () => {
    const node = await h.create("dev");
    expect(node.claimed_by).toBeNull();
    expect((await h.post(node.id, "claim")).body.claimed_by).toBe("human");
    expect((await h.post(node.id, "release")).body.claimed_by).toBeNull();
    expect((await eventsOf(node.id)).map((e) => e.kind)).toEqual(["node_created", "claim_taken", "claim_released"]);
  });

  it("lets a human claim again, logging nothing, as when reopening a session", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "claim");
    expect((await h.post(node.id, "claim", { actor: "human" })).status).toBe(200);
    expect((await eventsOf(node.id)).filter((e) => e.kind === "claim_taken")).toHaveLength(1);
  });

  it("allows one claim: neither side takes the other's, and agents don't share", async () => {
    const human = await h.create("dev");
    await h.post(human.id, "claim", { actor: "human" });
    expect((await h.post(human.id, "claim", { actor: "agent" })).status).toBe(409);
    expect((await h.node(human.id)).claimed_by).toBe("human");

    const agent = await h.create("dev");
    expect((await h.post(agent.id, "claim", { actor: "agent" })).body.claimed_by).toBe("agent");
    expect((await h.post(agent.id, "claim", { actor: "human" })).status).toBe(409);
    expect((await h.post(agent.id, "claim", { actor: "agent" })).status).toBe(409);
  });

  it("releases only your own claim, and refuses when there's none", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "release")).status).toBe(409);
    await h.post(node.id, "claim", { actor: "agent" });
    expect((await h.post(node.id, "release", { actor: "human" })).status).toBe(409);
    expect((await h.post(node.id, "release", { actor: "agent" })).body.claimed_by).toBeNull();
    await h.post(node.id, "claim", { actor: "human" });
    expect((await h.post(node.id, "release", { actor: "agent" })).status).toBe(409);
    expect((await h.node(node.id)).claimed_by).toBe("human");
  });

  it("refuses an unknown actor and a missing node", async () => {
    const node = await h.create("dev");
    expect((await h.post(node.id, "claim", { actor: "system" })).status).toBe(400);
    expect((await h.post("nope", "claim")).status).toBe(404);
    expect((await h.post("nope", "release")).status).toBe(404);
  });

  it("keeps a human's claim through every kind of stage change", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "claim");
    const steps: [string, unknown][] = [
      ["next", { outcome: "done" }],
      ["move", { stage: "implement" }],
      ["ask", { question: "Q?" }],
      ["answer", { answer: "A" }],
      ["fail", {}],
      ["retry", {}],
      ["block", { reason: "x" }],
      ["unblock", {}],
      ["split/start", {}],
      ["invalidate", { reason: "x" }],
      ["restore", {}],
      ["move", { stage: "done" }],
    ];
    for (const [action, body] of steps) {
      const res = await h.post(node.id, action, body);
      expect(res.status, action).toBe(200);
      expect(res.body.claimed_by, action).toBe("human");
    }
  });

  it("drops an agent's claim on a stage change, which ends its run, and records that", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "claim", { actor: "agent" });
    const res = await h.post(node.id, "next", { outcome: "done", actor: "agent" });
    expect(res.body.claimed_by).toBeNull();
    expect((await eventsOf(node.id)).at(-1)).toMatchObject({
      actor: "system",
      kind: "claim_released",
      data: { holder: "agent", via: "next" },
    });
  });

  it("keeps an agent's claim through split start only, because that agent carries on", async () => {
    const node = await atSplitApproved();
    await h.post(node.id, "claim", { actor: "agent" });
    expect((await h.post(node.id, "split/start")).body.claimed_by).toBe("agent");
    expect((await h.post(node.id, "ask", { question: "Q?" })).body.claimed_by).toBeNull();
  });
});

describe("one outcome per agent run", () => {
  it("refuses every agent move once the run has moved the node on, including fail", async () => {
    // Moves on to write_spec, another agent stage, while the run that reported is still exiting.
    const node = await h.create("triage");
    h.db
      .prepare("INSERT INTO runs (id, created_at, node_id, stage, status, log_path) VALUES ('r1', 'now', ?, 'awaiting_agent_breakdown', 'running', '/log')")
      .run(node.id);
    expect((await h.post(node.id, "next", { outcome: "ready", actor: "agent" })).body.stage).toBe("write_spec");

    expect((await h.post(node.id, "fail", { actor: "agent" })).status).toBe(409);
    expect((await h.post(node.id, "next", { outcome: "done", actor: "agent" })).status).toBe(409);
    expect((await h.post(node.id, "ask", { question: "Q?" })).status).toBe(409);
    expect((await h.post(node.id, "split/start")).status).toBe(409);
    expect((await h.node(node.id)).stage).toBe("write_spec");

    // Only an agent's report is the old run's. AOP and humans can still act on the node.
    expect((await h.post(node.id, "fail", { actor: "system" })).body.stage).toBe("failed");
  });
});

describe("blocks cycles", () => {
  it("refuses a direct and a longer cycle, changing nothing", async () => {
    const a = await h.create("dev");
    const b = await h.create("dev");
    const c = await h.create("dev");
    expect((await edge(a.id, b.id)).status).toBe(201);
    expect((await edge(b.id, c.id)).status).toBe(201);
    const direct = await edge(b.id, a.id);
    expect(direct.status).toBe(409);
    expect(JSON.stringify(direct.body)).toContain("blocks cycle");
    expect((await edge(c.id, a.id)).status).toBe(409);
    expect((await h.node(a.id)).blocked_by).toEqual([]);
    expect((await eventsOf(c.id)).some((e) => e.kind === "edge_added")).toBe(false);
  });

  it("allows a diamond, and ignores removed edges and subtask edges", async () => {
    const [a, b, c, d] = [await h.create("dev"), await h.create("dev"), await h.create("dev"), await h.create("dev")];
    await edge(a.id, b.id);
    await edge(a.id, c.id);
    await edge(b.id, d.id);
    expect((await edge(c.id, d.id)).status).toBe(201);

    const x = await h.create("dev");
    const y = await h.create("dev");
    const added = await edge(x.id, y.id);
    await h.call("DELETE", `/api/edges/${added.body["id"]}`);
    expect((await edge(y.id, x.id)).status).toBe(201);

    const parent = await h.create("dev");
    const child = await h.create("dev");
    await edge(parent.id, child.id, "subtask");
    expect((await edge(child.id, parent.id)).status).toBe(201);
    // Not a blocks cycle, and subtask edges aren't checked for one.
    expect((await edge(child.id, parent.id, "subtask")).status).toBe(201);
  });
});

describe("editing and messages, for either actor", () => {
  it("edits the title, keeping the old one in an event with the actor", async () => {
    const node = await h.create("dev", { title: "Old" });
    for (const actor of ["human", "agent"]) {
      const title = `By ${actor}`;
      const res = await h.call<NodeView>("PATCH", `/api/nodes/${node.id}`, { title, actor });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe(title);
      expect((await eventsOf(node.id)).at(-1)).toMatchObject({ actor, kind: "title_edited" });
    }
    expect((await eventsOf(node.id)).find((e) => e.kind === "title_edited")?.data).toEqual({ previous: "Old" });
  });

  it("edits both at once, recording each, and logs nothing unchanged", async () => {
    const node = await h.create("dev", { title: "T", body: "B" });
    await h.call("PATCH", `/api/nodes/${node.id}`, { title: "T2", body: "B2", actor: "agent" });
    expect((await eventsOf(node.id)).map((e) => e.kind)).toEqual(["node_created", "title_edited", "description_edited"]);
    await h.call("PATCH", `/api/nodes/${node.id}`, { title: "T2", body: "B2" });
    expect(await eventsOf(node.id)).toHaveLength(3);
  });

  it("checks the title, and needs something to edit", async () => {
    const node = await h.create("dev");
    const patch = (body: unknown) => h.call("PATCH", `/api/nodes/${node.id}`, body);
    expect((await patch({ title: "  " })).status).toBe(400);
    expect((await patch({ title: "a".repeat(201) })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ actor: "agent" })).status).toBe(400);
  });

  it("edits a node at any stage", async () => {
    const node = await h.create("dev");
    await h.post(node.id, "invalidate", { reason: "x" });
    expect((await h.call("PATCH", `/api/nodes/${node.id}`, { title: "Still", actor: "agent" })).status).toBe(200);
  });

  it("takes messages on a node at any stage, from anyone", async () => {
    const finished = await h.create("dev");
    await h.post(finished.id, "move", { stage: "done" });
    const invalid = await h.create("dev");
    await h.post(invalid.id, "invalidate", { reason: "x" });
    const blocked = await h.create("dev");
    await h.post(blocked.id, "block", { reason: "x" });
    const split = await splitting();

    for (const node of [finished, invalid, blocked, split]) {
      const res = await h.call("POST", `/api/nodes/${node.id}/messages`, { body: "Hello", author: "agent" });
      expect(res.status).toBe(201);
      expect(res.body["stage"]).toBe((await h.node(node.id)).stage);
    }
  });

  it("still refuses an agent on a human turn, at human and built-in stages", async () => {
    const review = await h.create("dev", { stage: "spec_review" });
    expect((await h.post(review.id, "next", { outcome: "approve", actor: "agent" })).status).toBe(409);
    expect((await h.post(review.id, "next", { outcome: "approve", actor: "human" })).status).toBe(200);
  });
});

describe("human move as the escape hatch", () => {
  it("moves from every finished or waiting stage", async () => {
    const parent = await h.create("dev");
    await childOf(parent.id);
    const setups: ((id: string) => Promise<unknown>)[] = [
      (id) => h.post(id, "move", { stage: "done" }),
      (id) => h.post(id, "invalidate", { reason: "x" }),
      (id) => h.post(id, "block", { reason: "x" }),
      (id) => h.post(id, "ask", { question: "Q?" }),
      (id) => h.post(id, "fail"),
    ];
    for (const setup of setups) {
      const node = await h.create("dev");
      await setup(node.id);
      const res = await h.post(node.id, "move", { stage: "pr_review" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ stage: "pr_review", return_stage: null, invalidation_reason: null });
    }
    await h.post(parent.id, "move", { stage: "broken_down" });
    expect((await h.post(parent.id, "move", { stage: "pr_review" })).body.stage).toBe("pr_review");
  });
});
