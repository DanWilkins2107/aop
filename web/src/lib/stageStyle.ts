import type { NodeView, StagesView, TypeView } from "../../../src/shared/api/types.js";
import { type BuiltInStage, FINISHED_STAGES, GLOBAL_STAGES, isBuiltIn } from "../../../src/shared/domain/builtInStages.js";
import { mix, parseHex, readableText, visibleOn } from "./color.js";
import { claimLabel, humanize } from "./format.js";

/** Built-ins have no config of their own, so their colours live here. */
const BUILT_IN_COLORS: Record<BuiltInStage, string> = {
  done: "#57b56f",
  broken_down: "#96a0d4",
  invalidated: "#8f969d",
  scheduled: "#4fbfc4",
  ask_human_question: "#eba23f",
  failed: "#e06666",
  externally_blocked: "#d98050",
  splitting: "#62aee3",
};

/** `color` is optional in `stages.yaml`. */
const UNSET_COLOR = "#adb5bd";
export const MISSING_STAGE_COLOR = "#e06666";

export function stageColor(stage: string, stages: StagesView | null): string {
  const configured = stages?.stages.find((s) => s.name === stage)?.color;
  const color = configured ?? (isBuiltIn(stage) ? BUILT_IN_COLORS[stage] : undefined) ?? UNSET_COLOR;
  return parseHex(color) ? color : UNSET_COLOR;
}

export function findType(stages: StagesView | null, name: string): TypeView | undefined {
  return stages?.types.find((t) => t.name === name);
}

/** What the graph's "Hide invalidated" toggle hides. */
export function isInvalidated(node: NodeView): boolean {
  return node.stage === "invalidated" || node.invalidated_by_parent;
}

/** What the Improvements page's "Hide done and invalidated" toggle hides. */
export function isFinished(node: NodeView): boolean {
  return node.stage === "done" || isInvalidated(node);
}

/**
 * `inactive` is what isn't for picking up right now: blocked or held. `done` is as faded, with a
 * green tint so finished work tells apart from stuck work. `broken_down` and `invalidated` recede
 * further, because nothing more will happen on those cards.
 */
export type CardKind = "human" | "agent" | "inactive" | "done" | "broken_down" | "invalidated";

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
    case "done":
      return { ...lookOf("inactive", color), background: "#e3f2e6", border: "#57b56f" };
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
  if (node.stage === "done") return "done";
  if (FINISHED_STAGES.includes(node.stage) || node.blocked_by.length > 0 || node.held) return "inactive";
  return node.turn === "human" ? "human" : "agent";
}

export function cardLook(node: NodeView, stages: StagesView | null): CardLook {
  const color = node.stage_exists ? stageColor(node.stage, stages) : MISSING_STAGE_COLOR;
  return lookOf(cardKind(node), color);
}

/**
 * The band across the top of the node page, the one place outside the graph that shows a stage's
 * colour. Stages that are over use the grey their graph cards go.
 */
export function stageBand(node: NodeView, stages: StagesView | null): { background: string; text: string } {
  const color = node.stage_exists ? stageColor(node.stage, stages) : MISSING_STAGE_COLOR;
  if (node.stage_exists && (FINISHED_STAGES.includes(node.stage) || isInvalidated(node))) {
    const { background, text } = lookOf("inactive", color);
    return { background, text };
  }
  const background = fillOf(color);
  return { background, text: readableText(background) };
}

/** Where a node's stage is, in words. */
export function stageLabel(node: NodeView): string {
  if (!node.stage_exists) return `${humanize(node.stage)}: stage gone`;
  if (node.invalidated_by_parent && node.stage !== "invalidated") return "Invalidated by parent";
  return humanize(node.stage);
}

/** The type shown on a card. Global stages don't show one. */
export function cardType(node: NodeView): string | null {
  return GLOBAL_STAGES.includes(node.stage) ? null : node.type;
}

/**
 * What a graph card's link reads out. The canvas is an application region, so a screen reader hears
 * only this, and it has to carry what sighted users get from the card's fill: that a human needs to
 * act. Blocked and held cards are greyed for reasons the card doesn't spell out either.
 */
export function cardName(node: NodeView): string {
  const type = cardType(node);
  const parts = [node.title, type ? `${stageLabel(node)}, ${humanize(type)}` : stageLabel(node)];
  if (cardKind(node) === "human") parts.push("Needs a human");
  if (!isInvalidated(node) && node.blocked_by.length > 0) parts.push("Blocked");
  if (!isInvalidated(node) && node.held) parts.push("Held until a split finishes");
  const claim = claimLabel(node);
  if (claim) parts.push(claim.title);
  return parts.join(". ");
}
