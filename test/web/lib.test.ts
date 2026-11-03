import { describe, expect, it } from "vitest";
import type { EventView, NodeView, TypeView } from "../../src/shared/api.js";
import { contrast, ensureBright, luminance, parseHex, readableText, visibleOn } from "../../web/src/lib/color.js";
import { CARD_HEIGHT, CARD_WIDTH, layoutGraph, smoothPath } from "../../web/src/lib/layout.js";
import { pipelineFor, shapeOf } from "../../web/src/lib/pipeline.js";
import { describeEvent, humanize, stageOptionGroups } from "../../web/src/lib/format.js";
import { cardKind, cardLook, isInvalidated, lookOf } from "../../web/src/lib/stageStyle.js";

const COLORS = ["#ffc107", "#cddc39", "#000000", "#ffffff", "#123", "#4263eb", "#e91e63", "#808080", "#12b886aa"];

describe("colour", () => {
  it("reads every hex form the config allows, and rejects lengths CSS doesn't", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#ffffff80")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("#1234567")).toBeNull();
  });

  it("picks text that stays legible on any colour", () => {
    for (const color of COLORS) expect(contrast(readableText(color), color)).toBeGreaterThanOrEqual(4.5);
  });

  it("shifts a colour until it shows against a background", () => {
    for (const color of COLORS) {
      expect(contrast(visibleOn(color, "#1f2226", 3), "#1f2226")).toBeGreaterThanOrEqual(3);
      expect(contrast(visibleOn(color, "#ffffff", 3), "#ffffff")).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps a dark configured colour bright on a human card", () => {
    expect(luminance(ensureBright("#000000"))).toBeGreaterThanOrEqual(0.2);
  });

  it("keeps every card's text and pill legible, whatever the colour", () => {
    for (const color of COLORS) {
      for (const kind of ["bright", "dark", "muted", "dimmed"] as const) {
        const look = lookOf(kind, color);
        expect(contrast(look.text, look.background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(look.pillText, look.pillBackground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

function nodeAt(stage: string, extra: Partial<NodeView> = {}): NodeView {
  return {
    id: "n",
    created_at: "2026-01-01T00:00:00Z",
    project_id: "p",
    title: "T",
    body: "",
    type: "flow",
    stage,
    cron: null,
    invalidation_reason: null,
    return_stage: null,
    spawned_by: null,
    stage_exists: true,
    turn: "agent",
    available_outcomes: [],
    invalidated_by_parent: false,
    invalidated_ancestors: [],
    blocked_by: [],
    held: false,
    held_by: [],
    claimed_by: null,
    ...extra,
  };
}

function change(from: string, to: string, type = "flow", fromType = type): EventView {
  return {
    id: `${from}-${to}`,
    created_at: "2026-01-01T00:00:00Z",
    node_id: "n",
    actor: "human",
    kind: "stage_changed",
    data: { from_stage: from, to_stage: to, from_type: fromType, to_type: type },
  };
}

const created = (stage: string, type = "flow"): EventView => ({
  id: "created",
  created_at: "2026-01-01T00:00:00Z",
  node_id: "n",
  actor: "human",
  kind: "node_created",
  data: { type, stage },
});

// Invented names, because nothing may depend on the example's stages.
const FLOW: TypeView = {
  name: "flow",
  start: "alpha",
  stages: [
    { name: "alpha", next: [{ outcome: "go", target: "beta" }] },
    {
      name: "beta",
      next: [
        { outcome: "go", target: "gamma" },
        { outcome: "redo", target: "alpha" },
      ],
    },
    {
      name: "gamma",
      next: [
        { outcome: "finish", target: "done" },
        { outcome: "redo", target: "beta" },
      ],
    },
  ],
};

describe("pipeline", () => {
  it("draws the line from the type and ends at its terminal", () => {
    expect(shapeOf(FLOW)).toEqual({ rail: ["alpha", "beta", "gamma"], terminal: "done", branches: [] });
  });

  it("marks visited, current and future stages from events", () => {
    const { rail, side } = pipelineFor(nodeAt("beta"), FLOW, [created("alpha"), change("alpha", "beta")]);
    expect(rail.map((s) => s.state)).toEqual(["visited", "current", "future", "future"]);
    expect(side).toBeNull();
  });

  it("marks a jumped-over stage as skipped", () => {
    const { rail } = pipelineFor(nodeAt("gamma"), FLOW, [created("alpha"), change("alpha", "gamma")]);
    expect(rail.map((s) => s.state)).toEqual(["visited", "skipped", "current", "future"]);
  });

  it("lists outcomes that leave the line, marking those that go back", () => {
    const { rail } = pipelineFor(nodeAt("beta"), FLOW, [created("alpha")]);
    expect(rail[1]?.others).toEqual([{ outcome: "redo", target: "alpha", back: true }]);
  });

  it("puts side states off the rail, anchored where the node came from", () => {
    const events = [created("alpha"), change("alpha", "failed")];
    for (const stage of ["failed", "ask_human_question", "externally_blocked", "splitting"]) {
      const { rail, side } = pipelineFor(nodeAt(stage, { return_stage: "alpha" }), FLOW, events);
      expect(side).toEqual({ stage, anchor: "alpha" });
      expect(rail.map((s) => s.stage)).not.toContain(stage);
      expect(rail[0]?.state).toBe("visited");
    }
  });

  it("anchors an invalidated node from its event", () => {
    const { side } = pipelineFor(nodeAt("invalidated"), FLOW, [created("alpha"), change("alpha", "invalidated")]);
    expect(side).toEqual({ stage: "invalidated", anchor: "alpha" });
  });

  it("flags a removed stage as off the rail", () => {
    const { side } = pipelineFor(nodeAt("removed", { stage_exists: false }), FLOW, [created("alpha")]);
    expect(side).toEqual({ stage: "removed", anchor: null });
  });

  it("appends a finish the type has no route to", () => {
    const type: TypeView = { name: "flow", start: "alpha", stages: [{ name: "alpha", next: [] }] };
    const { rail, side } = pipelineFor(nodeAt("broken_down"), type, [created("alpha"), change("alpha", "broken_down")]);
    expect(rail.map((s) => s.stage)).toEqual(["alpha", "broken_down"]);
    expect(rail[1]?.state).toBe("current");
    expect(side).toBeNull();
  });

  it("shows a fork's shorter route as a branch", () => {
    const type: TypeView = {
      name: "flow",
      start: "a",
      stages: [
        {
          name: "a",
          next: [
            { outcome: "short", target: "s" },
            { outcome: "long", target: "l1" },
          ],
        },
        { name: "s", next: [{ outcome: "end", target: "done" }] },
        { name: "l1", next: [{ outcome: "on", target: "l2" }] },
        { name: "l2", next: [{ outcome: "end", target: "done" }] },
      ],
    };
    const shape = shapeOf(type);
    expect(shape.rail).toEqual(["a", "l1", "l2"]);
    expect(shape.branches).toEqual([{ from: "a", stages: ["s"] }]);
  });

  it("names earlier types, and doesn't count a same-named stage in another type as visited", () => {
    const events = [created("alpha", "other"), change("alpha", "beta", "flow", "other")];
    const { rail, cameFrom } = pipelineFor(nodeAt("beta"), FLOW, events);
    expect(cameFrom).toEqual(["other"]);
    expect(rail[0]?.state).toBe("skipped");
  });

  it("draws nothing when the type is gone", () => {
    const { rail, side } = pipelineFor(nodeAt("beta", { stage_exists: false }), undefined, []);
    expect(rail).toEqual([]);
    expect(side).toEqual({ stage: "beta", anchor: null });
  });
});

describe("card kind", () => {
  it("is bright for any human turn, including built-ins it doesn't know", () => {
    expect(cardKind(nodeAt("anything", { turn: "human" }))).toBe("bright");
    expect(cardKind(nodeAt("externally_blocked", { turn: "human" }))).toBe("bright");
    expect(cardKind(nodeAt("splitting", { turn: "agent" }))).toBe("dark");
    expect(cardKind(nodeAt("scheduled", { turn: null }))).toBe("dark");
  });

  it("mutes finished nodes and dims dead ones", () => {
    expect(cardKind(nodeAt("done", { turn: null }))).toBe("muted");
    expect(cardKind(nodeAt("broken_down", { turn: null }))).toBe("muted");
    expect(cardKind(nodeAt("invalidated", { turn: null }))).toBe("dimmed");
    expect(cardKind(nodeAt("beta", { turn: "human", invalidated_by_parent: true }))).toBe("dimmed");
  });

  it("makes a removed stage demand attention", () => {
    expect(cardKind(nodeAt("gone", { turn: null, stage_exists: false }))).toBe("bright");
  });
});

describe("graph layout", () => {
  const edge = (id: string, source_id: string, target_id: string, kind: "subtask" | "blocks") => ({
    id,
    source_id,
    target_id,
    kind,
  });

  it("puts parents above children and blockers above what they block", () => {
    const at = layoutGraph(["p", "c", "b"], [edge("1", "p", "c", "subtask"), edge("2", "c", "b", "blocks")]).positions;
    expect(at.get("p")!.y).toBeLessThan(at.get("c")!.y);
    expect(at.get("c")!.y).toBeLessThan(at.get("b")!.y);
  });

  it("doesn't overlap cards, even with both edge kinds between one pair", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const edges = [edge("1", "a", "b", "subtask"), edge("2", "a", "b", "blocks"), edge("3", "a", "c", "subtask")];
    const at = layoutGraph(ids, edges).positions;
    for (const first of ids) {
      for (const second of ids) {
        if (first === second) continue;
        const overlapX = Math.abs(at.get(first)!.x - at.get(second)!.x) < CARD_WIDTH;
        const overlapY = Math.abs(at.get(first)!.y - at.get(second)!.y) < CARD_HEIGHT;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("survives a cycle and an edge to a node it wasn't given", () => {
    const edges = [edge("1", "a", "b", "blocks"), edge("2", "b", "a", "blocks"), edge("3", "a", "x", "subtask")];
    const { positions, routes } = layoutGraph(["a", "b"], edges);
    expect(positions.size).toBe(2);
    expect([...routes.keys()].sort()).toEqual(["1", "2"]);
  });

  it("wraps unconnected nodes into rows, and keeps routes with their moved cards", () => {
    const ids = ["p", "c", ...Array.from({ length: 12 }, (_, i) => `solo${i}`)];
    const { positions, routes } = layoutGraph(ids, [edge("1", "p", "c", "subtask")]);
    const ys = new Set([...positions.values()].map((at) => at.y));
    expect(ys.size).toBeGreaterThan(2);
    const points = routes.get("1") ?? [];
    expect(points[0]?.y).toBeGreaterThanOrEqual(positions.get("p")!.y);
    expect(points[points.length - 1]?.y).toBeLessThanOrEqual(positions.get("c")!.y + CARD_HEIGHT);
  });

  it("routes a long edge around a card in its way", () => {
    const edges = [edge("1", "a", "b", "subtask"), edge("2", "b", "c", "blocks"), edge("3", "a", "c", "subtask")];
    const { positions, routes } = layoutGraph(["a", "b", "c"], edges);
    const b = positions.get("b")!;
    for (const point of routes.get("3") ?? []) {
      const inside = point.x > b.x && point.x < b.x + CARD_WIDTH && point.y > b.y && point.y < b.y + CARD_HEIGHT;
      expect(inside).toBe(false);
    }
  });

  it("draws a path through a route", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([{ x: 0, y: 0 }, { x: 0, y: 10 }])).toBe("M 0 0 L 0 10");
    expect(smoothPath([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }])).toBe("M 0 0 Q 0 10 5 10 L 10 10");
  });
});

describe("display names", () => {
  it("formats known abbreviations, wherever they fall", () => {
    expect(humanize("pr_review")).toBe("PR review");
    expect(humanize("pr_raised")).toBe("PR raised");
    expect(humanize("second_pr_review")).toBe("Second PR review");
    expect(humanize("fix-ci")).toBe("Fix CI");
    expect(humanize("qa")).toBe("QA");
  });

  it("leaves other words alone, including ones containing an abbreviation", () => {
    expect(humanize("split_proposed")).toBe("Split proposed");
    expect(humanize("print_review")).toBe("Print review");
    expect(humanize("approve")).toBe("Approve");
    expect(humanize("ask_human_question")).toBe("Ask human question");
  });

  it("groups stages by type, with values a move or a new node can send", () => {
    const groups = stageOptionGroups({ start: "flow", stages: [], types: [FLOW] });
    expect(groups[0]?.group).toBe("Flow");
    expect(groups[0]?.options[0]).toEqual({ label: "Alpha", value: JSON.stringify({ stage: "alpha", type: "flow" }) });
  });
});

describe("history text", () => {
  const event = (kind: string, data: Record<string, unknown>): EventView => ({
    id: "e",
    created_at: "2026-01-01T00:00:00Z",
    node_id: "n",
    actor: "human",
    kind,
    data,
  });
  const line = (kind: string, data: Record<string, unknown>) => describeEvent(event(kind, data), (id) => id);

  it("describes the new stage changes", () => {
    const change = (via: string, extra = {}) => line("stage_changed", { via, from_stage: "pr_review", to_stage: "pr_review", ...extra });
    expect(change("block", { reason: "Vendor" })).toBe("Externally blocked at PR review: Vendor");
    expect(change("unblock")).toBe("Unblocked, back to PR review");
    expect(change("split_start")).toBe("Started splitting at PR review");
    expect(change("split_finish")).toBe("Finished splitting");
  });

  it("describes title edits and claims", () => {
    expect(line("title_edited", { previous: "Old" })).toBe("Title edited, was: Old");
    expect(line("claim_taken", { holder: "human" })).toBe("Claimed by a human");
    expect(line("claim_released", { holder: "agent" })).toBe("Claim released by an agent run");
  });
});

describe("waiting and hidden cards", () => {
  it("fades a held card like a blocked one", () => {
    expect(cardLook(nodeAt("beta", { held: true }), null).opacity).toBeLessThan(1);
    expect(cardLook(nodeAt("beta"), null).opacity).toBe(1);
  });

  it("counts a node as invalidated if it or a parent is", () => {
    expect(isInvalidated(nodeAt("invalidated"))).toBe(true);
    expect(isInvalidated(nodeAt("beta", { invalidated_by_parent: true }))).toBe(true);
    expect(isInvalidated(nodeAt("beta"))).toBe(false);
    expect(isInvalidated(nodeAt("done"))).toBe(false);
  });
});
