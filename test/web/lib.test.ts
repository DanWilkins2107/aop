import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { EventView, NodeView, TypeView } from "../../src/shared/api.js";
import { contrast, parseHex, readableText, visibleOn } from "../../web/src/lib/color.js";
import { CARD_HEIGHT, CARD_WIDTH, fittedViewport, layoutGraph, smoothPath } from "../../web/src/lib/layout.js";
import { originalStage, stageDrawing } from "../../web/src/lib/stageGraph.js";
import { describeEvent, humanize, stageOptionGroups } from "../../web/src/lib/format.js";
import { cardKind, cardLook, cardType, isInvalidated, lookOf, stageColor, stageLabel } from "../../web/src/lib/stageStyle.js";

const COLORS = ["#ffc107", "#cddc39", "#000000", "#ffffff", "#123", "#4263eb", "#e91e63", "#808080", "#12b886aa"];

describe("colour", () => {
  it("reads every hex form the config allows, and rejects lengths CSS doesn't", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#ffffff80")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("#1234567")).toBeNull();
  });

  it("shifts a colour until it shows against a background", () => {
    for (const color of COLORS) {
      expect(contrast(visibleOn(color, "#1f2226", 3), "#1f2226")).toBeGreaterThanOrEqual(3);
      expect(contrast(visibleOn(color, "#ffffff", 3), "#ffffff")).toBeGreaterThanOrEqual(3);
    }
  });

  it("picks text that stays legible on any colour", () => {
    for (const color of COLORS) expect(contrast(readableText(color), color)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps every card's text legible, whatever the colour", () => {
    for (const color of COLORS) {
      for (const kind of ["human", "agent", "inactive", "invalidated"] as const) {
        const look = lookOf(kind, color);
        expect(contrast(look.text, look.background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps agent cards white, with an accent that shows", () => {
    for (const color of COLORS) {
      const look = lookOf("agent", color);
      expect(look.background).toBe("#ffffff");
      expect(contrast(look.accent!, "#ffffff")).toBeGreaterThanOrEqual(3);
    }
  });

  it("fills human cards with the stage's own colour, ignoring alpha", () => {
    expect(lookOf("human", "#4263eb").background).toBe("#4263eb");
    expect(lookOf("human", "#12b886aa").background).toBe("#12b886");
  });

  it("greys out inactive cards whatever the colour, and strikes invalidated ones without fading them", () => {
    const inactive = lookOf("inactive", "#57b56f");
    expect(inactive.accent).toBeNull();
    expect(inactive.opacity).toBeLessThan(1);
    expect(lookOf("inactive", "#e91e63")).toEqual(inactive);
    const invalidated = lookOf("invalidated", "#57b56f");
    expect(invalidated.struck).toBe(true);
    expect(invalidated.opacity).toBe(1);
  });

  it("uses a stage's colour as a fill only when a human needs to act", () => {
    expect(lookOf("human", "#e91e63").background).not.toBe(lookOf("human", "#12b886").background);
    for (const kind of ["agent", "inactive", "invalidated"] as const) {
      expect(lookOf(kind, "#e91e63").background).toBe(lookOf(kind, "#12b886").background);
    }
  });
});

describe("default stage colours", () => {
  const demo = parse(readFileSync("demo/config/stages.yaml", "utf8")) as { stages: Record<string, { color: string }> };
  const BUILT_INS = ["done", "broken_down", "invalidated", "scheduled", "ask_human_question", "failed", "externally_blocked", "splitting"];
  const defaults = [...Object.values(demo.stages).map((s) => s.color), ...BUILT_INS.map((s) => stageColor(s, null))];

  it("stay legible on every card", () => {
    for (const color of defaults) {
      for (const kind of ["human", "agent", "inactive", "invalidated"] as const) {
        const look = lookOf(kind, color);
        expect(contrast(look.text, look.background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("are all different, and none is a fully saturated colour", () => {
    expect(new Set(defaults).size).toBe(defaults.length);
    for (const color of defaults) {
      const { r, g, b } = parseHex(color)!;
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(180);
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

describe("pipeline drawing", () => {
  const box = (type: TypeView, name: string, current = "alpha", returnTo: string | null = null) =>
    stageDrawing(type, current, returnTo).boxes.find((b) => b.name === name);

  it("draws every stage and every outcome, including loops back and the finish", () => {
    const { boxes, links } = stageDrawing(FLOW, "beta", null);
    expect(boxes.map((b) => b.name).sort()).toEqual(["alpha", "beta", "done", "gamma"]);
    expect(links.map((l) => l.id).sort()).toEqual(["alpha:go", "beta:go", "beta:redo", "gamma:finish", "gamma:redo"]);
    for (const link of links) expect(link.points.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link.labelAt).not.toBeNull();
  });

  it("orders stages by route and keeps the start at the top, despite the loops", () => {
    const y = (name: string) => box(FLOW, name)!.y;
    expect(y("alpha")).toBeLessThan(y("beta"));
    expect(y("beta")).toBeLessThan(y("gamma"));
    expect(y("gamma")).toBeLessThan(y("done"));
  });

  it("gives a fork's routes their own places", () => {
    const type: TypeView = {
      name: "flow",
      start: "a",
      stages: [
        {
          name: "a",
          next: [
            { outcome: "left", target: "l" },
            { outcome: "right", target: "other_type" },
          ],
        },
        { name: "l", next: [] },
      ],
    };
    const left = box(type, "l")!;
    const right = box(type, "other_type")!;
    expect(left.y).toBe(right.y);
    expect(left.x).not.toBe(right.x);
    expect(right.kind).toBe("exit");
    expect(left.kind).toBe("stage");
  });

  it("highlights the current stage only", () => {
    const kinds = stageDrawing(FLOW, "beta", null).boxes.filter((b) => b.kind === "current");
    expect(kinds.map((b) => b.name)).toEqual(["beta"]);
  });

  it("leaves global stages out and marks where the node returns to", () => {
    for (const stage of ["failed", "ask_human_question", "externally_blocked", "invalidated"]) {
      const { boxes } = stageDrawing(FLOW, stage, "beta");
      expect(boxes.map((b) => b.name)).not.toContain(stage);
      expect(boxes.filter((b) => b.kind === "current")).toEqual([]);
      expect(boxes.find((b) => b.name === "beta")?.kind).toBe("return");
    }
  });

  it("draws a current stage that's off the type beside it", () => {
    for (const stage of ["splitting", "broken_down", "removed"]) {
      expect(box(FLOW, stage, stage)?.kind).toBe("current");
    }
  });

  it("copes with an outcome that loops to its own stage, and two to one target", () => {
    const type: TypeView = {
      name: "flow",
      start: "a",
      stages: [
        {
          name: "a",
          next: [
            { outcome: "again", target: "a" },
            { outcome: "one", target: "done" },
            { outcome: "two", target: "done" },
          ],
        },
      ],
    };
    const { links } = stageDrawing(type, "a", null);
    expect(links).toHaveLength(3);
    for (const link of links) expect(link.points.length).toBeGreaterThan(0);
  });

  it("finds a node's original stage from return_stage, or else from its events", () => {
    expect(originalStage(nodeAt("failed", { return_stage: "beta" }), [])).toBe("beta");
    expect(originalStage(nodeAt("invalidated"), [created("alpha"), change("alpha", "beta"), change("beta", "invalidated")])).toBe("beta");
    expect(originalStage(nodeAt("invalidated"), [])).toBeNull();
  });
});

describe("card kind", () => {
  it("is coloured for any human turn, including built-ins it doesn't know", () => {
    expect(cardKind(nodeAt("anything", { turn: "human" }))).toBe("human");
    expect(cardKind(nodeAt("externally_blocked", { turn: "human" }))).toBe("human");
    expect(cardKind(nodeAt("splitting", { turn: "agent" }))).toBe("agent");
    expect(cardKind(nodeAt("scheduled", { turn: null }))).toBe("agent");
  });

  it("greys out what isn't for picking up, even on a human's turn, and strikes out dead ones", () => {
    expect(cardKind(nodeAt("done", { turn: null }))).toBe("inactive");
    expect(cardKind(nodeAt("broken_down", { turn: null }))).toBe("inactive");
    expect(cardKind(nodeAt("beta", { turn: "human", blocked_by: ["x"] }))).toBe("inactive");
    expect(cardKind(nodeAt("beta", { turn: "human", held: true }))).toBe("inactive");
    expect(cardKind(nodeAt("invalidated", { turn: null }))).toBe("invalidated");
    expect(cardKind(nodeAt("beta", { turn: "human", invalidated_by_parent: true }))).toBe("invalidated");
  });

  it("makes a removed stage demand attention", () => {
    expect(cardKind(nodeAt("gone", { turn: null, stage_exists: false }))).toBe("human");
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

  it("packs unconnected nodes into narrower rows for a narrower aspect", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `solo${i}`);
    const widest = (aspect: number) => Math.max(...[...layoutGraph(ids, [], aspect).positions.values()].map((p) => p.x));
    expect(widest(0.6)).toBeLessThan(widest(1.9));
  });

  it("fits every card in view, centred", () => {
    const options = { padding: { x: 20, y: 20 }, minZoom: 0.1, maxZoom: 1 };
    const positions = [{ x: 0, y: 0 }, { x: 1000, y: 500 }];
    const { x, y, zoom } = fittedViewport(positions, { width: 800, height: 400 }, options);
    expect(zoom).toBeLessThan(1);
    expect(x).toBeGreaterThanOrEqual(20);
    expect(y).toBeGreaterThanOrEqual(20);
    expect(x + (1000 + CARD_WIDTH) * zoom).toBeLessThanOrEqual(780.01);
    expect(y + (500 + CARD_HEIGHT) * zoom).toBeLessThanOrEqual(380.01);
  });

  it("won't zoom past the maximum, and centres a small graph", () => {
    const { x, zoom } = fittedViewport([{ x: 0, y: 0 }], { width: 1000, height: 600 }, { padding: { x: 20, y: 20 }, minZoom: 0.1, maxZoom: 1 });
    expect(zoom).toBe(1);
    expect(x).toBe((1000 - CARD_WIDTH) / 2);
  });

  it("starts at the top left when the graph is too big to read at once", () => {
    const options = { padding: { x: 16, y: 16 }, minZoom: 0.7, maxZoom: 1 };
    const { x, y, zoom } = fittedViewport([{ x: 100, y: 50 }, { x: 3000, y: 2000 }], { width: 375, height: 600 }, options);
    expect(zoom).toBe(0.7);
    expect(x).toBeCloseTo(16 - 100 * 0.7);
    expect(y).toBeCloseTo(16 - 50 * 0.7);
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
  it("greys blocked, held, done and broken_down cards to the same opacity", () => {
    const opacity = (node: NodeView) => cardLook(node, null).opacity;
    const greyed = [
      nodeAt("beta", { held: true }),
      nodeAt("beta", { blocked_by: ["x"] }),
      nodeAt("done", { turn: null }),
      nodeAt("broken_down", { turn: null }),
    ].map(opacity);
    expect(new Set(greyed).size).toBe(1);
    expect(greyed[0]).toBeLessThan(1);
    expect(opacity(nodeAt("beta"))).toBe(1);
  });

  it("drops the type on global stages only", () => {
    for (const stage of ["invalidated", "externally_blocked", "ask_human_question", "failed"]) {
      expect(cardType(nodeAt(stage))).toBeNull();
    }
    expect(cardType(nodeAt("beta"))).toBe("flow");
    expect(cardType(nodeAt("done"))).toBe("flow");
  });

  it("says in words what used to take a badge", () => {
    expect(stageLabel(nodeAt("pr_review"))).toBe("PR review");
    expect(stageLabel(nodeAt("beta", { invalidated_by_parent: true }))).toBe("Invalidated by parent");
    expect(stageLabel(nodeAt("legal_signoff", { stage_exists: false }))).toBe("Legal signoff: stage gone");
  });

  it("counts a node as invalidated if it or a parent is", () => {
    expect(isInvalidated(nodeAt("invalidated"))).toBe(true);
    expect(isInvalidated(nodeAt("beta", { invalidated_by_parent: true }))).toBe(true);
    expect(isInvalidated(nodeAt("beta"))).toBe(false);
    expect(isInvalidated(nodeAt("done"))).toBe(false);
  });
});
