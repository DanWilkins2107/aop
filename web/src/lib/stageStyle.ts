import type { NodeView, StagesView, TypeView } from "../../../src/shared/api.js";
import { mix, parseHex, readableText, visibleOn } from "./color.js";
import { humanize } from "./format.js";

/** The built-in stages that finish a node. */
export const FINISHED_STAGES: readonly string[] = ["done", "broken_down"];

/** Reachable from anywhere, so they live outside every type's pipeline. */
export const GLOBAL_STAGES: readonly string[] = ["invalidated", "externally_blocked", "ask_human_question", "failed"];

/** Built-ins have no config of their own, so their colours live here. */
const BUILT_IN_COLORS = new Map([
  ["done", "#57b56f"],
  ["broken_down", "#96a0d4"],
  ["invalidated", "#8f969d"],
  ["scheduled", "#4fbfc4"],
  ["ask_human_question", "#eba23f"],
  ["failed", "#e06666"],
  ["externally_blocked", "#d98050"],
  ["splitting", "#62aee3"],
]);

/** `color` is optional in `stages.yaml`. */
const UNSET_COLOR = "#adb5bd";
export const MISSING_STAGE_COLOR = "#e06666";

export function stageColor(stage: string, stages: StagesView | null): string {
  const configured = stages?.stages.find((s) => s.name === stage)?.color;
  const color = configured ?? BUILT_IN_COLORS.get(stage) ?? UNSET_COLOR;
  return parseHex(color) ? color : UNSET_COLOR;
}

export function findType(stages: StagesView | null, name: string): TypeView | undefined {
  return stages?.types.find((t) => t.name === name);
}

/** What the graph's "Hide invalidated" toggle hides. */
export function isInvalidated(node: NodeView): boolean {
  return node.stage === "invalidated" || node.invalidated_by_parent;
}

/** What the graph's "Hide finished" toggle hides. */
export function isFinished(node: NodeView): boolean {
  return FINISHED_STAGES.includes(node.stage);
}

/**
 * `inactive` is what isn't for picking up right now: blocked, held or done. `broken_down` and
 * `invalidated` recede further, because nothing more will happen on those cards.
 */
export type CardKind = "human" | "agent" | "inactive" | "broken_down" | "invalidated";

export interface CardLook {
  background: string;
  border: string;
  borderWidth: number;
  /** A small mark of the stage's colour, on cards that aren't filled with it. */
  accent: string | null;
  text: string;
  opacity: number;
  struck: boolean;
}

const INK = "#1f2226";
const SURFACE = "#ffffff";
const INACTIVE_OPACITY = 0.7;
const RECEDED_OPACITY = 0.45;
/** Work in progress or waiting on a human, which the eye should find first. */
const LIVE_BORDER_WIDTH = 2;

/** The fill that means a human needs to act: the stage's own colour, without any alpha from config. */
export const fillOf = (color: string) => mix(color, color, 0);

/** A stage's colour, dark enough to use as a small mark on white. */
export const accentOf = (color: string) => visibleOn(color, SURFACE, 3);

export function lookOf(kind: CardKind, color: string): CardLook {
  switch (kind) {
    case "human": {
      const background = fillOf(color);
      return { background, border: mix(background, "#000000", 0.45), borderWidth: LIVE_BORDER_WIDTH, accent: null, text: readableText(background), opacity: 1, struck: false };
    }
    case "agent": {
      const accent = accentOf(color);
      return { background: SURFACE, border: accent, borderWidth: LIVE_BORDER_WIDTH, accent, text: INK, opacity: 1, struck: false };
    }
    case "inactive":
      return { background: "#e9ecef", border: "#ced4da", borderWidth: 1, accent: null, text: "#343a40", opacity: INACTIVE_OPACITY, struck: false };
    case "broken_down":
      return { ...lookOf("inactive", color), opacity: RECEDED_OPACITY };
    case "invalidated":
      return { background: SURFACE, border: "#adb5bd", borderWidth: 1, accent: null, text: "#343a40", opacity: RECEDED_OPACITY, struck: true };
  }
}

/** A coloured card means a human needs to act, so this turns on `turn` and not on a stage's name. */
export function cardKind(node: NodeView): CardKind {
  if (isInvalidated(node)) return "invalidated";
  if (!node.stage_exists) return "human";
  if (node.stage === "broken_down") return "broken_down";
  if (FINISHED_STAGES.includes(node.stage) || node.blocked_by.length > 0 || node.held) return "inactive";
  return node.turn === "human" ? "human" : "agent";
}

export function cardLook(node: NodeView, stages: StagesView | null): CardLook {
  const color = node.stage_exists ? stageColor(node.stage, stages) : MISSING_STAGE_COLOR;
  return lookOf(cardKind(node), color);
}

/** Where a node's stage is, in words. Carries what used to take a badge. */
export function stageLabel(node: NodeView): string {
  if (!node.stage_exists) return `${humanize(node.stage)}: stage gone`;
  if (node.invalidated_by_parent && node.stage !== "invalidated") return "Invalidated by parent";
  return humanize(node.stage);
}

/** The type shown on a card. Global stages don't show one. */
export function cardType(node: NodeView): string | null {
  return GLOBAL_STAGES.includes(node.stage) ? null : node.type;
}
