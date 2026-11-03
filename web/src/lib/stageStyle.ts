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

/** `inactive` is everything that isn't for picking up: blocked, held or finished. */
export type CardKind = "human" | "agent" | "inactive" | "invalidated";

export interface CardLook {
  background: string;
  border: string;
  /** A small mark of the stage's colour, on cards that aren't filled with it. */
  accent: string | null;
  text: string;
  opacity: number;
  struck: boolean;
}

const INK = "#1f2226";
const SURFACE = "#ffffff";
const INACTIVE_OPACITY = 0.7;

/** The fill that means a human needs to act: the stage's own colour, without any alpha from config. */
export const fillOf = (color: string) => mix(color, color, 0);

/** A stage's colour, dark enough to use as a small mark on white. */
export const accentOf = (color: string) => visibleOn(color, SURFACE, 3);

export function lookOf(kind: CardKind, color: string): CardLook {
  switch (kind) {
    case "human": {
      const background = fillOf(color);
      return { background, border: mix(background, "#000000", 0.2), accent: null, text: readableText(background), opacity: 1, struck: false };
    }
    case "agent":
      return { background: SURFACE, border: "#d5d9de", accent: accentOf(color), text: INK, opacity: 1, struck: false };
    case "inactive":
      return { background: "#e9ecef", border: "#ced4da", accent: null, text: "#343a40", opacity: INACTIVE_OPACITY, struck: false };
    case "invalidated":
      return { background: SURFACE, border: "#adb5bd", accent: null, text: "#5c636a", opacity: 1, struck: true };
  }
}

/** A coloured card means a human needs to act, so this turns on `turn` and not on a stage's name. */
export function cardKind(node: NodeView): CardKind {
  if (isInvalidated(node)) return "invalidated";
  if (!node.stage_exists) return "human";
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
