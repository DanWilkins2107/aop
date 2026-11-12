import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { EventView, NodeView, TypeView } from "../../src/shared/api/types.js";
import { contrast, parseHex, readableText, visibleOn } from "../../web/src/lib/color.js";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  fittedViewport,
  graphView,
  inReadingOrder,
  layoutGraph,
  shownGraph,
  smoothPath,
  structureKey,
} from "../../web/src/lib/layout.js";
import { originalStage, stageDrawing } from "../../web/src/lib/stageGraph.js";
import { describeEvent } from "../../web/src/lib/eventText.js";
import {
  claimLabel,
  formatDuration,
  formatStart,
  formatTokens,
  humanize,
  runEnding,
  stageOptionGroups,
} from "../../web/src/lib/format.js";
import { cardKind, cardLook, cardName, cardType, isFinished, isInvalidated, lookOf, stageColor, stageLabel } from "../../web/src/lib/stageStyle.js";

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
      for (const kind of ["human", "agent", "inactive", "done", "broken_down", "invalidated"] as const) {
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

  it("greys out inactive cards whatever the colour, and fades finished-for-good ones further", () => {
    const inactive = lookOf("inactive", "#57b56f");
    expect(inactive.accent).toBeNull();
    expect(inactive.opacity).toBeLessThan(1);
    expect(lookOf("inactive", "#e91e63")).toEqual(inactive);
    const invalidated = lookOf("invalidated", "#57b56f");
    expect(invalidated.struck).toBe(true);
    expect(invalidated.opacity).toBeLessThan(inactive.opacity);
    const brokenDown = lookOf("broken_down", "#57b56f");
    expect(brokenDown.opacity).toBe(invalidated.opacity);
    expect(brokenDown.accent).toBeNull();
    const done = lookOf("done", "#57b56f");
    expect(done.opacity).toBe(inactive.opacity);
    expect(done.background).not.toBe(inactive.background);
    expect(done.border).not.toBe(inactive.border);
  });

  it("gives cards that are live a stronger border in the stage's colour family", () => {
    for (const color of ["#ffc107", "#7088e0", "#35a98b", "#d96aa6", "#4263eb"]) {
      const agent = lookOf("agent", color);
      expect(agent.borderWidth).toBeGreaterThan(lookOf("inactive", color).borderWidth);
      expect(contrast(agent.border, agent.background)).toBeGreaterThanOrEqual(3);
      const human = lookOf("human", color);
      expect(human.borderWidth).toBeGreaterThan(lookOf("inactive", color).borderWidth);
      expect(contrast(human.border, human.background)).toBeGreaterThanOrEqual(2);
    }
  });

  it("uses a stage's colour as a fill only when a human needs to act", () => {
    expect(lookOf("human", "#e91e63").background).not.toBe(lookOf("human", "#12b886").background);
    for (const kind of ["agent", "inactive", "done", "broken_down", "invalidated"] as const) {
      expect(lookOf(kind, "#e91e63").background).toBe(lookOf(kind, "#12b886").background);
    }
  });
});

describe("run history", () => {
  const event = (kind: string, data: unknown) => ({ id: "e", created_at: "", node_id: "n", actor: "system" as const, kind, data });
  it("names runs by the start of their ID, and says how they ended", () => {
    expect(describeEvent(event("run_started", { run_id: "12345678-aaaa" }), String)).toBe("Agent run 12345678 started");
    expect(describeEvent(event("run_ended", { run_id: "12345678-aaaa", reason: "stopped" }), String)).toBe("Agent run 12345678 ended: it was stopped");
  });
});

describe("default stage colours", () => {
  const shipped = parse(readFileSync("defaults/stages.yaml", "utf8")) as { stages: Record<string, { color: string }> };
  const BUILT_INS = ["done", "broken_down", "invalidated", "scheduled", "ask_human_question", "failed", "externally_blocked", "splitting"];
  const defaults = [...Object.values(shipped.stages).map((s) => s.color), ...BUILT_INS.map((s) => stageColor(s, null))];

  it("stay legible on every card", () => {
    for (const color of defaults) {
      for (const kind of ["human", "agent", "inactive", "done", "broken_down", "invalidated"] as const) {
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
    run_id: null,
    last_run_id: null,
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
    next_fire_at: null,
    claimed_by: null,
    kind: "work",
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
    expect(cardKind(nodeAt("done", { turn: null }))).toBe("done");
    expect(cardKind(nodeAt("broken_down", { turn: null }))).toBe("broken_down");
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

  it("orders cards for Tab row by row, left to right, whatever order they were made in", () => {
    const positions = new Map([
      ["late-root", { x: 400, y: 0 }],
      ["child", { x: 0, y: 120 }],
      ["root", { x: 0, y: 0.4 }],
      ["sibling", { x: 260, y: 120 }],
    ]);
    const nodes = ["child", "sibling", "late-root", "root"].map((id) => ({ id }));
    expect(inReadingOrder(nodes, positions).map((node) => node.id)).toEqual(["root", "late-root", "child", "sibling"]);
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

  it("keeps unconnected nodes in one row, however many there are", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `solo${i}`);
    const at = [...layoutGraph(ids, []).positions.values()];
    expect(new Set(at.map((p) => p.y))).toEqual(new Set([0]));
    expect(new Set(at.map((p) => p.x)).size).toBe(60);
  });

  it("starts connected groups on the same row, side by side, with routes kept to their cards", () => {
    const ids = ["solo0", "p", "c", "solo1", "b1", "b2"];
    const { positions, routes } = layoutGraph(ids, [edge("1", "p", "c", "subtask"), edge("2", "b1", "b2", "blocks")]);
    const at = (id: string) => positions.get(id)!;
    for (const id of ["solo0", "solo1", "p", "b1"]) expect(at(id).y).toBe(0);
    for (const id of ["c", "b2"]) expect(at(id).y).toBeGreaterThan(0);
    expect(new Set(ids.filter((id) => at(id).y === 0).map((id) => at(id).x)).size).toBe(4);

    const route = routes.get("2") ?? [];
    expect(route[0]!.x).toBeCloseTo(at("b1").x + CARD_WIDTH / 2, 0);
    expect(route[route.length - 1]!.x).toBeCloseTo(at("b2").x + CARD_WIDTH / 2, 0);
  });

  describe("keeps nodes in the same place", () => {
    const made = (id: string, order: number) => ({ id, created_at: `2026-01-01T00:00:${String(order).padStart(2, "0")}Z` });
    const nodes = ["old", "p", "c1", "c2", "solo", "b1", "b2", "late"].map(made);
    const edges = [edge("1", "p", "c1", "subtask"), edge("2", "p", "c2", "subtask"), edge("3", "b1", "b2", "blocks")];
    const everything = graphView(nodes, edges, () => false);

    it("lays out what's left as if hidden nodes weren't there, closing their gaps", () => {
      const hidden = new Set(["old", "c1", "b1"]);
      const view = graphView(nodes, edges, (node) => hidden.has(node.id));
      expect(view.nodes.map((node) => node.id)).toEqual(["p", "c2", "solo", "b2", "late"]);
      expect(view.edges.map((e) => e.id)).toEqual(["2"]);
      const without = graphView(
        nodes.filter((node) => !hidden.has(node.id)),
        edges.filter((e) => !hidden.has(e.source_id) && !hidden.has(e.target_id)),
        () => false,
      );
      expect(view.positions).toEqual(without.positions);
      expect(view.routes).toEqual(without.routes);
      expect(view.positions.get("p")!.x).toBe(0);
    });

    it("doesn't move a shown card when a hidden part of the graph grows", () => {
      const hidden = (node: { id: string }) => node.id === "p" || node.id.startsWith("c");
      const before = graphView(nodes, edges, hidden);
      const after = graphView([...nodes, made("c3", 30)], [...edges, edge("4", "p", "c3", "subtask")], hidden);
      expect(after.positions).toEqual(before.positions);
      expect(after.routes).toEqual(before.routes);
    });

    describe("structure key", () => {
      const keyOf = (ns: typeof nodes, es: typeof edges) => {
        const shown = shownGraph(ns, es, () => false);
        return structureKey(shown.nodes, shown.edges);
      };
      const key = keyOf(nodes, edges);

      it("stays the same for the same cards and edges, whatever order or extra fields they arrive with", () => {
        const refetched = [...nodes].reverse().map((node) => ({ ...node, stage: "done" }));
        expect(keyOf(refetched, [...edges].reverse())).toBe(key);
      });

      it("changes when a node is hidden, shown, added or removed, or an edge changes", () => {
        const hiddenKey = (() => {
          const shown = shownGraph(nodes, edges, (node) => node.id === "c1");
          return structureKey(shown.nodes, shown.edges);
        })();
        const changed = [
          hiddenKey,
          keyOf([...nodes, made("new", 30)], edges),
          keyOf(nodes.slice(1), edges),
          keyOf(nodes, [...edges, edge("4", "solo", "late", "blocks")]),
          keyOf(nodes, [edge("1", "p", "c1", "blocks"), ...edges.slice(1)]),
        ];
        for (const other of changed) expect(other).not.toBe(key);
        expect(new Set(changed).size).toBe(changed.length);
      });
    });

    it("puts a new unconnected node at the right end without moving anything", () => {
      const more = graphView([...nodes, made("new", 30)], edges, () => false);
      for (const node of nodes) expect(more.positions.get(node.id)).toEqual(everything.positions.get(node.id));
      const others = nodes.map((node) => everything.positions.get(node.id)!.x);
      expect(more.positions.get("new")!.x).toBeGreaterThan(Math.max(...others));
      expect(more.positions.get("new")!.y).toBe(0);
    });

    it("orders groups by their oldest node and not by size, whatever order they arrive in", () => {
      const at = graphView([...nodes].reverse(), edges, () => false).positions;
      expect(at).toEqual(everything.positions);
      const xs = ["old", "p", "solo", "b1", "late"].map((id) => at.get(id)!.x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    });

    it("moves only later groups, all by the same distance, when a group gets a new child", () => {
      const more = graphView(
        [...nodes, made("c3", 30)],
        [...edges, edge("4", "p", "c3", "subtask")],
        () => false,
      ).positions;
      expect(more.get("old")).toEqual(everything.positions.get("old"));
      const shifts = ["solo", "b1", "b2", "late"].map((id) => more.get(id)!.x - everything.positions.get(id)!.x);
      expect(shifts[0]).toBeGreaterThan(0);
      for (const shift of shifts) expect(shift).toBeCloseTo(shifts[0]!);
    });
  });

  describe("moves as little as it can when a child is added", () => {
    const xsOf = (at: Map<string, { x: number; y: number }>, ids: string[]) => ids.map((id) => at.get(id)!.x);
    const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);
    // Two earlier groups, then a tree that gets new children: under the root, and under a child.
    const ids = ["solo", "a", "a1", "a2", "t", "t1", "t2", "t3", "t11", "t12", "t31"];
    const edges = [
      edge("e1", "a", "a1", "subtask"),
      edge("e2", "a", "a2", "subtask"),
      edge("e3", "a1", "a2", "blocks"),
      edge("e4", "t", "t1", "subtask"),
      edge("e5", "t", "t2", "subtask"),
      edge("e6", "t", "t3", "subtask"),
      edge("e7", "t1", "t11", "subtask"),
      edge("e8", "t1", "t12", "subtask"),
      edge("e9", "t3", "t31", "subtask"),
      edge("e10", "t12", "t3", "blocks"),
    ];
    const before = layoutGraph(ids, edges).positions;
    const rows = (at: Map<string, { x: number; y: number }>) => {
      const byY = new Map<number, string[]>();
      for (const id of ids.slice(4)) byY.set(at.get(id)!.y, [...(byY.get(at.get(id)!.y) ?? []), id]);
      return [...byY.values()].map((row) => row.sort((p, q) => at.get(p)!.x - at.get(q)!.x));
    };

    for (const [parent, child] of [["t", "t4"], ["t1", "t13"], ["t31", "t311"]] as const) {
      it(`leaves earlier groups alone and keeps the order in each row, adding ${child} under ${parent}`, () => {
        const after = layoutGraph([...ids, child], [...edges, edge("new", parent, child, "subtask")]).positions;
        for (const id of ids.slice(0, 4)) expect(after.get(id)).toEqual(before.get(id));
        for (const row of rows(before)) {
          expect(new Set(row.map((id) => after.get(id)!.y)).size).toBe(1);
          expect(ascending(xsOf(after, row))).toBe(true);
        }
        // The new child goes after the siblings it already had.
        const siblings = edges.filter((e) => e.source_id === parent && e.kind === "subtask").map((e) => e.target_id);
        for (const sibling of siblings) expect(after.get(child)!.x).toBeGreaterThan(after.get(sibling)!.x);
      });
    }

    it("lays out the same graph the same way, whatever order the edges arrive in", () => {
      expect(layoutGraph(ids, [...edges].reverse()).positions).toEqual(before);
    });
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

  it("fits every card in view, from the top of the canvas", () => {
    const options = { padding: { x: 20, y: 20 }, minZoom: 0.1, maxZoom: 1 };
    const positions = [{ x: 0, y: 0 }, { x: 1000, y: 500 }];
    const { x, y, zoom } = fittedViewport(positions, { width: 800, height: 400 }, options);
    expect(zoom).toBeLessThan(1);
    expect(x).toBeGreaterThanOrEqual(20);
    expect(y).toBe(20);
    expect(x + (1000 + CARD_WIDTH) * zoom).toBeLessThanOrEqual(780.01);
    expect(y + (500 + CARD_HEIGHT) * zoom).toBeLessThanOrEqual(380.01);
  });

  it("puts a short graph at the top rather than in the middle", () => {
    const options = { padding: { x: 56, y: 24 }, minZoom: 0.5, maxZoom: 1 };
    const row = [0, 1, 2].map((i) => ({ x: i * 292, y: 0 }));
    const { x, y, zoom } = fittedViewport(row, { width: 1440, height: 800 }, options);
    expect(zoom).toBe(1);
    expect(y).toBe(24);
    expect(x).toBeCloseTo((1440 - (2 * 292 + CARD_WIDTH)) / 2);
  });

  it("stops at the floor for a wide graph, at its top left", () => {
    const options = { padding: { x: 56, y: 24 }, minZoom: 0.5, maxZoom: 1 };
    const wide = Array.from({ length: 20 }, (_, i) => ({ x: i * 292, y: (i % 3) * 138 }));
    expect(fittedViewport(wide, { width: 1440, height: 800 }, options)).toEqual({ x: 56, y: 24, zoom: 0.5 });
  });

  it("won't zoom past the maximum, and centres a small graph", () => {
    const { x, zoom } = fittedViewport([{ x: 0, y: 0 }], { width: 1000, height: 600 }, { padding: { x: 20, y: 20 }, minZoom: 0.1, maxZoom: 1 });
    expect(zoom).toBe(1);
    expect(x).toBe((1000 - CARD_WIDTH) / 2);
  });

  it("starts a row too wide to read at the top left, even though its height would fit", () => {
    const options = { padding: { x: 56, y: 24 }, minZoom: 0.5, maxZoom: 1 };
    const row = Array.from({ length: 40 }, (_, i) => ({ x: i * 292, y: 0 }));
    expect(fittedViewport(row, { width: 1400, height: 800 }, options)).toEqual({ x: 56, y: 24, zoom: 0.5 });
  });

  it("starts at the top left when the graph is too big to read at once", () => {
    const options = { padding: { x: 16, y: 16 }, minZoom: 0.7, maxZoom: 1 };
    const { x, y, zoom } = fittedViewport([{ x: 100, y: 50 }, { x: 3000, y: 2000 }], { width: 375, height: 600 }, options);
    expect(zoom).toBe(0.7);
    expect(x).toBeCloseTo(16 - 100 * 0.7);
    expect(y).toBeCloseTo(16 - 50 * 0.7);
  });

  it("names a claim by its holder, or by an agent's short run ID", () => {
    expect(claimLabel({ claimed_by: null, run_id: null })).toBeNull();
    expect(claimLabel({ claimed_by: "human", run_id: null })).toEqual({ text: "human", title: "Claimed by human" });
    expect(claimLabel({ claimed_by: "agent", run_id: "0123456789abcdef" })).toEqual({
      text: "01234567",
      title: "Claimed by agent run 0123456789abcdef",
    });
    expect(claimLabel({ claimed_by: "agent", run_id: null })).toEqual({ text: "agent", title: "Claimed by agent" });
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

  it("describes a human's save, and what older versions wrote into a checkout", () => {
    expect(line("stage_changed", { via: "save_locally", from_stage: "review_change", to_stage: "done" })).toBe(
      "Saved locally: Review change → Done",
    );
    expect(line("proposals_applied", { written: ["a", "b"] })).toBe("Wrote 2 files");
    expect(line("proposals_applied", { written: ["a"], skipped: [], into: "C:/wt" })).toBe("Wrote 1 file into C:/wt");
  });

  it("describes title edits and claims", () => {
    expect(line("title_edited", { previous: "Old" })).toBe("Title edited, was: Old");
    expect(line("claim_taken", { holder: "human" })).toBe("Claimed by a human");
    expect(line("claim_released", { holder: "agent" })).toBe("Claim released by an agent run");
  });

  it("still renders kinds, vias and reasons from older databases that this version doesn't know", () => {
    expect(line("label_added", { label: "x" })).toBe("Label added");
    expect(line("stage_changed", { via: "teleport", from_stage: "alpha", to_stage: "beta" })).toBe("Alpha → Beta");
    expect(line("run_ended", { run_id: "12345678-aaaa", reason: "vanished" })).toBe("Agent run 12345678 ended: vanished");
    expect(line("scheduled_run_skipped", { reason: "too_busy" })).toBe("Scheduled run skipped: Too busy");
    expect(line("toString", {})).toBe(humanize("toString"));
  });
});

describe("waiting and hidden cards", () => {
  it("greys blocked, held and done cards to one opacity, and recedes broken_down and invalidated further", () => {
    const opacity = (node: NodeView) => cardLook(node, null).opacity;
    const greyed = [
      nodeAt("beta", { held: true }),
      nodeAt("beta", { blocked_by: ["x"] }),
      nodeAt("done", { turn: null }),
    ].map(opacity);
    expect(new Set(greyed).size).toBe(1);
    expect(greyed[0]).toBeLessThan(1);
    const receded = [
      nodeAt("broken_down", { turn: null }),
      nodeAt("invalidated", { turn: null }),
      nodeAt("beta", { invalidated_by_parent: true }),
    ].map(opacity);
    expect(new Set(receded).size).toBe(1);
    expect(receded[0]).toBeLessThan(greyed[0]!);
    expect(opacity(nodeAt("beta"))).toBe(1);
  });

  it("drops the type on global stages only", () => {
    for (const stage of ["invalidated", "externally_blocked", "ask_human_question", "failed"]) {
      expect(cardType(nodeAt(stage))).toBeNull();
    }
    expect(cardType(nodeAt("beta"))).toBe("flow");
    expect(cardType(nodeAt("done"))).toBe("flow");
  });

  it("says in words where a node's stage is", () => {
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

  it("counts a node as finished if it's done or invalidated", () => {
    expect(isFinished(nodeAt("done"))).toBe(true);
    expect(isFinished(nodeAt("invalidated"))).toBe(true);
    expect(isFinished(nodeAt("beta", { invalidated_by_parent: true }))).toBe(true);
    expect(isFinished(nodeAt("beta"))).toBe(false);
    expect(isFinished(nodeAt("broken_down"))).toBe(false);
  });

  it("names a card's link with what its colour says, so a screen reader hears it too", () => {
    expect(cardName(nodeAt("pr_review", { title: "Fix login" }))).toBe("Fix login. PR review, Flow");
    expect(cardName(nodeAt("pr_review", { title: "Fix login", turn: "human" }))).toBe("Fix login. PR review, Flow. Needs a human");
    expect(cardName(nodeAt("failed", { title: "Fix login", turn: "human" }))).toBe("Fix login. Failed. Needs a human");
    expect(cardName(nodeAt("gone", { stage_exists: false }))).toBe("T. Gone: stage gone, Flow. Needs a human");
    expect(cardName(nodeAt("beta", { turn: "human", blocked_by: ["x"] }))).toBe("T. Beta, Flow. Blocked");
    expect(cardName(nodeAt("beta", { held: true }))).toBe("T. Beta, Flow. Held until a split finishes");
    expect(cardName(nodeAt("beta", { invalidated_by_parent: true, blocked_by: ["x"] }))).toBe("T. Invalidated by parent, Flow");
    expect(cardName(nodeAt("beta", { claimed_by: "agent", run_id: "r1234567890" }))).toBe(
      "T. Beta, Flow. Claimed by agent run r1234567890",
    );
    expect(cardName(nodeAt("beta", { turn: "human", claimed_by: "human" }))).toBe("T. Beta, Flow. Needs a human. Claimed by human");
  });
});

describe("the runs table", () => {
  it("shows durations, token counts and endings briefly", () => {
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(725_000)).toBe("12m 5s");
    expect(formatDuration(12_000_000)).toBe("3h 20m");
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(1_250)).toBe("1.3k");
    expect(formatTokens(30_507)).toBe("31k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect((["running", "exited", "failed", "stopped", "timed_out"] as const).map(runEnding)).toEqual([
      "Still running",
      "Exited",
      "Failed",
      "Stopped",
      "Timed out",
    ]);
  });

  it("shows only the time for a run that started today, and the date before that", () => {
    const now = new Date(2026, 10, 5, 15, 0);
    const today = formatStart(new Date(2026, 10, 5, 9, 30).toISOString(), now);
    const earlier = formatStart(new Date(2026, 10, 3, 9, 30).toISOString(), now);
    expect(earlier.endsWith(today)).toBe(true);
    expect(earlier.length).toBeGreaterThan(today.length);
  });
});
