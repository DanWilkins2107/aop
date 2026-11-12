import type { NodeView } from "../../../src/shared/nodes/types.js";
import type { RunView } from "../../../src/shared/runs/types.js";
import type { StagesView } from "../../../src/shared/stages/types.js";

const ABBREVIATIONS = /\b(api|ci|db|id|pr|qa|sql|ui|url|ux)\b/gi;

/** "split_proposed" to "Split proposed", "pr_review" to "PR review". Display only: names come from config. */
export function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim().replace(ABBREVIATIONS, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A button's label, with where it leads when that's known. */
export const toTarget = (label: string, target: string | null) => (target ? `${label} → ${humanize(target)}` : label);

/** Every stage a type lists, grouped by type, for a dropdown. Values are JSON of `{ stage, type }`. */
export function stageOptionGroups(stages: StagesView): { group: string; options: { label: string; value: string }[] }[] {
  return stages.types.map((type) => ({
    group: humanize(type.name),
    options: type.stages.map((stage) => ({
      label: humanize(stage.name),
      value: JSON.stringify({ stage: stage.name, type: type.name }),
    })),
  }));
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Enough of a run's ID to tell it apart. `aop ps` shows the whole thing, which starts the same. */
export const shortRunId = (runId: string) => runId.slice(0, 8);

/**
 * What a claim shows: "human", or an agent's short run ID with the whole ID in the tooltip. An
 * agent's claim with no run, which a seeded or recovering node can have, falls back to "agent".
 */
export function claimLabel(node: Pick<NodeView, "claimed_by" | "run_id">): { text: string; title: string } | null {
  if (node.claimed_by === null) return null;
  const runId = node.claimed_by === "agent" ? node.run_id : null;
  if (runId) return { text: shortRunId(runId), title: `Claimed by agent run ${runId}` };
  return { text: node.claimed_by, title: `Claimed by ${node.claimed_by}` };
}

/** How long something took: "45s", "12m 5s", "3h 20m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A token count, short: "850", "12.3k", "1.2M". A dash when the tool's output didn't say. */
export function formatTokens(count: number | null): string {
  if (count === null) return "—";
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

const RUN_VIEW_ENDINGS: Record<RunView["ending"], string> = {
  running: "Still running",
  exited: "Exited",
  failed: "Failed",
  stopped: "Stopped",
  timed_out: "Timed out",
};

export const runEnding = (ending: RunView["ending"]) => RUN_VIEW_ENDINGS[ending];

/** When a run started: the time today, or the date and time before that. */
export function formatStart(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}
