import type { NodeView, StagesView, TypeView } from "../../../src/shared/api.js";
import { ensureBright, mix, parseHex, readableText, visibleOn } from "./color.js";

/** The built-in stages that finish a node. They sit at the end of a rail, not off it. */
export const FINISHED_STAGES: readonly string[] = ["done", "broken_down"];

/** Built-ins have no config of their own, so their colours live here. */
const BUILT_IN_COLORS = new Map([
  ["done", "#40c057"],
  ["broken_down", "#748ffc"],
  ["invalidated", "#868e96"],
  ["scheduled", "#20c997"],
  ["ask_human_question", "#ff9800"],
  ["failed", "#fa5252"],
  ["externally_blocked", "#f76707"],
  ["splitting", "#4dabf7"],
]);

/** `color` is optional in `stages.yaml`. */
const UNSET_COLOR = "#adb5bd";
export const MISSING_STAGE_COLOR = "#fa5252";

const CARD_DARK = "#1f2226";
const CARD_MUTED = "#2b2e33";
const PILL_ON_BRIGHT = "#1a1b1e";

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

export type CardKind = "bright" | "dark" | "muted" | "dimmed";

export interface CardLook {
  background: string;
  border: string;
  accent: string | null;
  text: string;
  pillBackground: string;
  pillText: string;
  opacity: number;
}

const BLOCKED_OPACITY = 0.6;

export function lookOf(kind: CardKind, color: string): CardLook {
  switch (kind) {
    case "bright": {
      const background = ensureBright(color);
      return {
        background,
        border: mix(background, "#000000", 0.25),
        accent: null,
        text: readableText(background),
        pillBackground: PILL_ON_BRIGHT,
        pillText: visibleOn(background, PILL_ON_BRIGHT, 4.5),
        opacity: 1,
      };
    }
    case "dark": {
      const accent = visibleOn(color, CARD_DARK, 3);
      return {
        background: CARD_DARK,
        border: accent,
        accent,
        text: "#f1f3f5",
        pillBackground: accent,
        pillText: readableText(accent),
        opacity: 1,
      };
    }
    case "muted": {
      const pillBackground = mix(color, CARD_MUTED, 0.45);
      return {
        background: CARD_MUTED,
        border: mix(color, CARD_MUTED, 0.6),
        accent: null,
        text: "#c4c9ce",
        pillBackground,
        pillText: readableText(pillBackground),
        opacity: 0.85,
      };
    }
    case "dimmed":
      return {
        background: CARD_MUTED,
        border: "#868e96",
        accent: null,
        text: "#c4c9ce",
        pillBackground: "#495057",
        pillText: "#e9ecef",
        opacity: 0.55,
      };
  }
}

/** Bright means a human needs to act, so this turns on `turn` and not on a stage's name. */
export function cardKind(node: NodeView): CardKind {
  if (node.stage === "invalidated" || node.stale) return "dimmed";
  if (!node.stage_exists) return "bright";
  if (FINISHED_STAGES.includes(node.stage)) return "muted";
  return node.turn === "human" ? "bright" : "dark";
}

export function cardLook(node: NodeView, stages: StagesView | null): CardLook {
  const color = node.stage_exists ? stageColor(node.stage, stages) : MISSING_STAGE_COLOR;
  const look = lookOf(cardKind(node), color);
  return node.blocked_by.length > 0 ? { ...look, opacity: Math.min(look.opacity, BLOCKED_OPACITY) } : look;
}
