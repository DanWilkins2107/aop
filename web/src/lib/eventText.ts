// The history list's wording for each event kind the server records.
import type { EventKind, EventView, NodeEvent, RunEndReason, ScheduleSkip } from "../../../src/shared/api.js";
import { humanize } from "./format.js";

// A Record, so that adding a kind to `EventDataByKind` fails to compile until it's listed here.
const KNOWN_KINDS: Record<EventKind, true> = {
  node_created: true,
  title_edited: true,
  description_edited: true,
  stage_changed: true,
  message_added: true,
  claim_taken: true,
  claim_released: true,
  run_started: true,
  run_ended: true,
  link_added: true,
  edge_added: true,
  edge_removed: true,
  scheduled_run: true,
  scheduled_run_skipped: true,
};

/** Whether this version knows the event's kind, and so the shape of its data. */
export function isNodeEvent(event: EventView): event is NodeEvent {
  return Object.hasOwn(KNOWN_KINDS, event.kind) && typeof event.data === "object" && event.data !== null;
}

const RUN_ENDINGS: Record<RunEndReason, string> = {
  reported: "it reported an outcome",
  failed: "it didn't finish",
  stopped: "it was stopped",
  held: "a parent was invalidated",
  shutdown: "AOP closed",
};

const SKIP_REASONS: Record<ScheduleSkip["reason"], string> = {
  previous_unfinished: "the previous child hasn't finished",
  blocks: "blocked by another node",
  split: "a parent is still splitting",
  invalidated_parent: "a parent is invalidated",
  child_refused: "the child couldn't be created",
};

// Rows written by older versions can miss a field, so text is read defensively.
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A `default` that must be unreachable by type, but still answers for values from older databases. */
function unlisted<T>(_value: never, fallback: T): T {
  return fallback;
}

/** One line of history. `titleOf` names the other end of an edge. */
export function describeEvent(event: EventView, titleOf: (id: string) => string): string {
  if (!isNodeEvent(event)) return humanize(event.kind);
  switch (event.kind) {
    case "node_created":
      return `Created at ${humanize(text(event.data.stage))}`;
    case "stage_changed": {
      const { data } = event;
      const from = humanize(text(data.from_stage));
      const to = humanize(text(data.to_stage));
      switch (data.via) {
        case "next":
          return `${humanize(text(data.outcome))}: ${from} → ${to}`;
        case "move":
          return `Forced stage: ${from} → ${to}`;
        case "ask":
          return `Asked a question at ${from}`;
        case "answer":
          return `Answered, back to ${to}`;
        case "fail":
          return `Failed at ${from}${data.reason ? `: ${text(data.reason)}` : ""}`;
        case "retry":
          return `Retried, back to ${to}`;
        case "invalidate":
          return `Invalidated at ${from}: ${text(data.reason)}`;
        case "restore":
          return `Restored to ${to}`;
        case "block":
          return `Externally blocked at ${from}: ${text(data.reason)}`;
        case "unblock":
          return `Unblocked, back to ${to}`;
        case "split_start":
          return `Started splitting at ${from}`;
        case "split_finish":
          return "Finished splitting";
        default:
          return unlisted(data.via, `${from} → ${to}`);
      }
    }
    case "message_added":
      return `Message posted at ${humanize(text(event.data.stage))}`;
    case "description_edited":
      return "Description edited";
    case "title_edited":
      return `Title edited, was: ${text(event.data.previous)}`;
    case "claim_taken":
      return `Claimed by ${event.data.holder === "agent" ? "an agent run" : "a human"}`;
    case "claim_released":
      return `Claim released by ${event.data.holder === "agent" ? "an agent run" : "a human"}`;
    case "run_started":
      return `Agent run ${text(event.data.run_id).slice(0, 8)} started`;
    case "run_ended": {
      const reason = event.data.reason;
      return `Agent run ${text(event.data.run_id).slice(0, 8)} ended: ${RUN_ENDINGS[reason] ?? text(reason)}`;
    }
    case "link_added":
      return `${event.data.kind === "pr" ? "PR" : "Ticket"} linked: ${text(event.data.url)}`;
    case "edge_added":
      return `${event.data.kind === "blocks" ? "Now blocks" : "Subtask added:"} ${titleOf(text(event.data.target_id))}`;
    case "edge_removed":
      return `${event.data.kind === "blocks" ? "No longer blocks" : "Subtask removed:"} ${titleOf(text(event.data.target_id))}`;
    case "scheduled_run":
      return "Schedule fired: created a child";
    case "scheduled_run_skipped": {
      const reason = event.data.reason;
      return `Scheduled run skipped: ${SKIP_REASONS[reason] ?? humanize(text(reason))}`;
    }
    default:
      return unlisted(event, humanize((event as EventView).kind));
  }
}
