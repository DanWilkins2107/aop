import type { NodeView, StagesView, TypeView } from "../../../src/shared/api.js";
import { ensureBright, mix, parseHex, visibleOn } from "./color.js";

/** The built-in stages that finish a node. They sit at the end of a rail, not off it. */
export const FINISHED_STAGES: readonly string[] = ["done", "broken_down"];

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

/** The colour of an outcome's target, which may be a stage or a type entered at its start. */
export function targetColor(target: string, stages: StagesView | null): string {
  const type = stages?.types.find((t) => t.name === target);
  return stageColor(type ? type.start : target, stages);
}

export function findType(stages: StagesView | null, name: string): TypeView | undefined {
  return stages?.types.find((t) => t.name === name);
}

/** What the graph's "Hide invalidated" toggle hides. */
export function isInvalidated(node: NodeView): boolean {
  return node.stage === "invalidated" || node.invalidated_by_parent;
}

export type CardKind = "human" | "agent" | "finished" | "invalidated";

export interface CardLook {
  background: string;
  border: string;
  borderStyle: "solid" | "dashed";
  borderWidth: number;
  accent: string | null;
  text: string;
  pillBackground: string;
  pillText: string;
  opacity: number;
  struck: boolean;
}

const INK = "#1f2226";
const SURFACE = "#ffffff";
const WAITING_OPACITY = 0.7;
// Enough for INK to stay legible on a tint, however dark the configured colour is.
const TINT_MIN_LUMINANCE = 0.35;

const tintOf = (color: string) => ensureBright(mix(color, SURFACE, 0.45), TINT_MIN_LUMINANCE);

export function lookOf(kind: CardKind, color: string): CardLook {
  const plain = { borderStyle: "solid", borderWidth: 1, accent: null, opacity: 1, struck: false } as const;
  switch (kind) {
    case "human": {
      const background = tintOf(color);
      return {
        ...plain,
        background,
        border: mix(background, "#000000", 0.3),
        borderWidth: 2,
        text: INK,
        pillBackground: SURFACE,
        pillText: INK,
      };
    }
    case "agent": {
      const accent = visibleOn(color, SURFACE, 3);
      return {
        ...plain,
        background: SURFACE,
        border: "#cdd2d8",
        accent,
        text: INK,
        pillBackground: mix(accent, SURFACE, 0.78),
        pillText: INK,
      };
    }
    case "finished":
      return {
        ...plain,
        background: "#e9ecef",
        border: "#ced4da",
        text: "#495057",
        pillBackground: tintOf(color),
        pillText: INK,
      };
    case "invalidated":
      return {
        ...plain,
        background: "#f8f9fa",
        border: "#adb5bd",
        borderStyle: "dashed",
        borderWidth: 2,
        text: "#5c636a",
        pillBackground: "#dee2e6",
        pillText: "#495057",
        struck: true,
      };
  }
}

/** A coloured card means a human needs to act, so this turns on `turn` and not on a stage's name. */
export function cardKind(node: NodeView): CardKind {
  if (isInvalidated(node)) return "invalidated";
  if (!node.stage_exists) return "human";
  if (FINISHED_STAGES.includes(node.stage)) return "finished";
  return node.turn === "human" ? "human" : "agent";
}

export function cardLook(node: NodeView, stages: StagesView | null): CardLook {
  const color = node.stage_exists ? stageColor(node.stage, stages) : MISSING_STAGE_COLOR;
  const look = lookOf(cardKind(node), color);
  const waiting = node.blocked_by.length > 0 || node.held;
  return waiting ? { ...look, opacity: Math.min(look.opacity, WAITING_OPACITY) } : look;
}
