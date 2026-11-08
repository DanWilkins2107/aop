import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventView, MessageRow } from "../../src/shared/api.js";
import { messageVisits, splitForReply } from "../../web/src/lib/messageVisits.js";
import { harness, type Harness } from "../server/helpers.js";

const SAME_TIME = "2026-01-01T00:00:00.000Z";

/** Builds a log the way the server writes it, with every timestamp equal so that only order can decide. */
function log(start: string) {
  const events: EventView[] = [];
  const messages: MessageRow[] = [];
  let stage = start;
  const event = (kind: string, data: unknown) =>
    events.push({ id: `e${events.length}`, created_at: SAME_TIME, node_id: "n", actor: "human", kind, data });
  event("node_created", { stage });
  return {
    events,
    messages,
    move(to: string, extra: Record<string, unknown> = {}) {
      event("stage_changed", { via: "next", from_stage: stage, from_type: "dev", to_stage: to, to_type: "dev", ...extra });
      stage = to;
    },
    say(body: string, author: "human" | "agent" = "agent") {
      const id = `m${messages.length}`;
      messages.push({ id, created_at: SAME_TIME, node_id: "n", stage, author, body });
      event("message_added", { message_id: id, stage });
    },
  };
}

const shape = (events: EventView[], messages: MessageRow[]) =>
  messageVisits(events, messages).map((visit) => [
    visit.stage,
    visit.entries.map((entry) => (entry.kind === "message" ? entry.message.body : `(${entry.text})`)),
  ]);

describe("messageVisits", () => {
  it("has no visits without messages", () => {
    const l = log("implement");
    l.move("pr_review");
    expect(messageVisits(l.events, l.messages)).toEqual([]);
  });

  it("keeps messages in one card while the node stays, newest first", () => {
    const l = log("implement");
    l.say("first");
    l.say("second", "human");
    expect(shape(l.events, l.messages)).toEqual([["implement", ["second", "first"]]]);
  });

  it("makes a separate card for each visit when going back and forth", () => {
    const l = log("implement");
    l.say("a");
    l.move("pr_review");
    l.say("b");
    l.move("implement");
    l.say("c");
    l.move("pr_review");
    l.say("d");
    expect(shape(l.events, l.messages)).toEqual([
      ["pr_review", ["d"]],
      ["implement", ["c"]],
      ["pr_review", ["b"]],
      ["implement", ["a"]],
    ]);
  });

  it("leaves out a stage with no messages, without joining the visits around it", () => {
    const l = log("implement");
    l.say("before");
    l.move("pr_review");
    l.move("implement");
    l.say("after");
    expect(shape(l.events, l.messages)).toEqual([
      ["implement", ["after"]],
      ["implement", ["before"]],
    ]);
  });

  it("keeps one visit through a move that keeps the stage name", () => {
    const l = log("implement");
    l.say("before");
    l.move("implement");
    l.say("after");
    expect(shape(l.events, l.messages)).toEqual([["implement", ["after", "before"]]]);
  });

  it("notes a forced move at the start of the visit it leads into, even with no messages there", () => {
    const l = log("implement");
    l.say("a");
    l.move("pr_review", { via: "move" });
    l.move("implement", { via: "move", to_type: "hotfix" });
    l.say("b");
    expect(shape(l.events, l.messages)).toEqual([
      ["implement", ["b", "(Moved to Implement in Hotfix (forced))"]],
      ["pr_review", ["(Moved to PR review (forced))"]],
      ["implement", ["a"]],
    ]);
  });

  it("notes an outcome that jumps type, but not one within a type", () => {
    const l = log("awaiting_agent_breakdown");
    l.say("a");
    l.move("write_spec", { from_type: "triage", to_type: "dev" });
    l.say("b");
    l.move("spec_review");
    l.say("c");
    expect(shape(l.events, l.messages)).toEqual([
      ["spec_review", ["c"]],
      ["write_spec", ["b", "(Moved from Triage into Dev)"]],
      ["awaiting_agent_breakdown", ["a"]],
    ]);
  });

  it("never loses a message whose event hasn't loaded yet", () => {
    const l = log("implement");
    l.say("seen");
    const eventsSoFar = [...l.events];
    l.move("pr_review");
    l.say("early");
    expect(shape(eventsSoFar, l.messages)).toEqual([
      ["pr_review", ["early"]],
      ["implement", ["seen"]],
    ]);
  });

  it("skips an event whose message hasn't loaded yet", () => {
    const l = log("implement");
    l.say("seen");
    const messagesSoFar = [...l.messages];
    l.say("not yet");
    expect(shape(l.events, messagesSoFar)).toEqual([["implement", ["seen"]]]);
  });

  describe("against what the server really logs", () => {
    let h: Harness;
    beforeEach(() => {
      h = harness();
    });
    afterEach(() => h.close());

    const visitsOf = async (id: string) => {
      const events = (await h.call<EventView[]>("GET", `/api/nodes/${id}/events`)).body;
      const messages = (await h.call<MessageRow[]>("GET", `/api/nodes/${id}/messages`)).body;
      return shape(events, messages);
    };
    const say = (id: string, body: string, author = "agent") => h.call("POST", `/api/nodes/${id}/messages`, { body, author });

    it("puts a question and its answer in one card, between the visits either side", async () => {
      const node = await h.create("dev");
      await say(node.id, "starting");
      await h.post(node.id, "ask", { question: "Which way?" });
      await h.post(node.id, "answer", { answer: "That way." });
      await say(node.id, "carrying on");
      expect(await visitsOf(node.id)).toEqual([
        ["write_spec", ["carrying on"]],
        ["ask_human_question", ["That way.", "Which way?"]],
        ["write_spec", ["starting"]],
      ]);
    });

    it("notes a human's forced move and a jump between types, and nothing else", async () => {
      const node = await h.create("triage");
      await h.post(node.id, "next", { outcome: "ready" });
      await h.post(node.id, "next", { outcome: "done" });
      await h.post(node.id, "move", { stage: "implement" });
      expect(await visitsOf(node.id)).toEqual([
        ["implement", ["(Moved to Implement (forced))"]],
        ["write_spec", ["(Moved from Triage into Dev)"]],
      ]);
    });

    it("gives a node returning to a stage a new card", async () => {
      const node = await h.create("dev");
      await say(node.id, "spec v1");
      await h.post(node.id, "next", { outcome: "done" });
      await say(node.id, "needs work", "human");
      await h.post(node.id, "next", { outcome: "reject" });
      await say(node.id, "spec v2");
      expect(await visitsOf(node.id)).toEqual([
        ["write_spec", ["spec v2"]],
        ["spec_review", ["needs work"]],
        ["write_spec", ["spec v1"]],
      ]);
    });
  });
});

describe("splitForReply", () => {
  const stagesOf = (visits: ReturnType<typeof messageVisits>) => visits.map((visit) => visit.stage);

  it("keeps the newest agent message's visit in view and sets older ones aside", () => {
    const l = log("awaiting_agent_summary");
    l.say("summary");
    l.move("decision");
    l.say("what about cost?", "human");
    l.move("awaiting_agent_clarification");
    l.say("clarification");
    l.move("decision");
    const { recent, earlier } = splitForReply(messageVisits(l.events, l.messages));
    expect(stagesOf(recent)).toEqual(["awaiting_agent_clarification"]);
    expect(stagesOf(earlier)).toEqual(["decision", "awaiting_agent_summary"]);
  });

  it("keeps a human's newer messages in view too", () => {
    const l = log("implement");
    l.say("old");
    l.move("ask_human_question");
    l.say("which port?");
    l.move("pr_review");
    l.say("draft", "human");
    const { recent, earlier } = splitForReply(messageVisits(l.events, l.messages));
    expect(stagesOf(recent)).toEqual(["pr_review", "ask_human_question"]);
    expect(stagesOf(earlier)).toEqual(["implement"]);
  });

  it("sets nothing aside without an agent message", () => {
    const l = log("implement");
    l.say("a", "human");
    l.move("pr_review");
    l.say("b", "human");
    const { recent, earlier } = splitForReply(messageVisits(l.events, l.messages));
    expect(stagesOf(recent)).toEqual(["pr_review", "implement"]);
    expect(earlier).toEqual([]);
  });
});
