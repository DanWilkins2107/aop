import type { EventView, NodeView, StagesView } from "../../../src/shared/api.js";

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

const RUN_ENDINGS: Record<string, string> = {
  reported: "it reported an outcome",
  failed: "it didn't finish",
  stopped: "it was stopped",
  held: "a parent was invalidated",
  shutdown: "AOP closed",
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One line of history. `titleOf` names the other end of an edge. */
export function describeEvent(event: EventView, titleOf: (id: string) => string): string {
  const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as Record<string, unknown>;
  const from = humanize(text(data["from_stage"]));
  const to = humanize(text(data["to_stage"]));
  switch (event.kind) {
    case "node_created":
      return `Created at ${humanize(text(data["stage"]))}`;
    case "stage_changed":
      switch (data["via"]) {
        case "next":
          return `${humanize(text(data["outcome"]))}: ${from} → ${to}`;
        case "move":
          return `Forced stage: ${from} → ${to}`;
        case "ask":
          return `Asked a question at ${from}`;
        case "answer":
          return `Answered, back to ${to}`;
        case "fail":
          return `Failed at ${from}${data["reason"] ? `: ${text(data["reason"])}` : ""}`;
        case "retry":
          return `Retried, back to ${to}`;
        case "invalidate":
          return `Invalidated at ${from}: ${text(data["reason"])}`;
        case "restore":
          return `Restored to ${to}`;
        case "block":
          return `Externally blocked at ${from}: ${text(data["reason"])}`;
        case "unblock":
          return `Unblocked, back to ${to}`;
        case "split_start":
          return `Started splitting at ${from}`;
        case "split_finish":
          return "Finished splitting";
        default:
          return `${from} → ${to}`;
      }
    case "message_added":
      return `Message posted at ${humanize(text(data["stage"]))}`;
    case "description_edited":
      return "Description edited";
    case "title_edited":
      return `Title edited, was: ${text(data["previous"])}`;
    case "claim_taken":
      return `Claimed by ${data["holder"] === "agent" ? "an agent run" : "a human"}`;
    case "claim_released":
      return `Claim released by ${data["holder"] === "agent" ? "an agent run" : "a human"}`;
    case "run_started":
      return `Agent run ${text(data["run_id"]).slice(0, 8)} started`;
    case "run_ended":
      return `Agent run ${text(data["run_id"]).slice(0, 8)} ended: ${RUN_ENDINGS[text(data["reason"])] ?? text(data["reason"])}`;
    case "link_added":
      return `${data["kind"] === "pr" ? "PR" : "Ticket"} linked: ${text(data["url"])}`;
    case "edge_added":
      return `${data["kind"] === "blocks" ? "Now blocks" : "Subtask added:"} ${titleOf(text(data["target_id"]))}`;
    case "edge_removed":
      return `${data["kind"] === "blocks" ? "No longer blocks" : "Subtask removed:"} ${titleOf(text(data["target_id"]))}`;
    case "scheduled_run":
      return "Schedule fired: created a child";
    case "scheduled_run_skipped":
      return `Scheduled run skipped: ${SKIP_REASONS[text(data["reason"])] ?? humanize(text(data["reason"]))}`;
    default:
      return humanize(event.kind);
  }
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

const SKIP_REASONS: Record<string, string> = {
  previous_unfinished: "the previous child hasn't finished",
  blocks: "blocked by another node",
  split: "a parent is still splitting",
  invalidated_parent: "a parent is invalidated",
  child_refused: "the child couldn't be created",
};
