import type { Actor, EdgeRow, LinkRow } from "../nodes/types.js";
import type { RunEndReason } from "../runs/types.js";
import type { ScheduleSkip } from "../schedule/types.js";
import type { StageChangeVia } from "../stages/types.js";

/**
 * Each event kind the server records, mapped to its `data`. The stored JSON is exactly this, so
 * changing a shape here changes what new rows hold, while old rows keep what they were written with.
 */
export interface EventDataByKind {
  node_created: { type: string; stage: string; title: string };
  title_edited: { previous: string };
  description_edited: { previous: string };
  stage_changed: {
    via: StageChangeVia;
    from_stage: string;
    from_type: string;
    from_return_stage: string | null;
    to_stage: string;
    to_type: string;
    /** `next`: the outcome taken. */
    outcome?: string;
    /** `fail`, `invalidate` and `block`: the reason given. */
    reason?: string;
    /** AOP's own `fail`: the run that ended without reporting. */
    run_id?: string;
  };
  message_added: { message_id: string; stage: string };
  /** `run_id` when a run takes it; `via: "stop"` when stopping a run hands it to a human. */
  claim_taken: { holder: "human" | "agent"; run_id?: string; via?: "stop" };
  /** `via` is set when AOP drops an agent's claim, rather than its holder releasing it. */
  claim_released: { holder: "human" | "agent"; via?: StageChangeVia | "held" | "shutdown" | "stop" | "restart" };
  run_started: { run_id: string; stage: string };
  run_ended: { run_id: string; reason: RunEndReason; exit_code: number | null };
  link_added: { link_id: string; kind: LinkRow["kind"]; url: string };
  edge_added: { edge_id: string; target_id: string; kind: EdgeRow["kind"] };
  edge_removed: { edge_id: string; target_id: string; kind: EdgeRow["kind"] };
  scheduled_run: { due_at: string; child_id: string };
  scheduled_run_skipped: { due_at: string } & ScheduleSkip;
  /** A human set the schedule, or cleared it with null. Firing counts from here. */
  schedule_changed: { cron: string | null; previous: string | null };
  /** On the work node a message was captured from: the improvement it became. */
  improvement_captured: { improvement_id: string; message_id: string };
  /** On the improvement: the work node and message it was captured from. */
  improvement_sourced: { node_id: string; message_id: string };
  proposal_saved: { path: string };
  proposal_withdrawn: { path: string };
  /** The real files a human's save wrote. `skipped` and `into` are only on rows from older versions. */
  proposals_applied: { written: string[]; skipped?: string[]; into?: string | null };
}

export type EventKind = keyof EventDataByKind;

/**
 * An event as the API returns it. Older databases can hold kinds this version no longer writes, so
 * `kind` stays a string and `data` unknown: narrow to `NodeEvent` before reading `data`.
 */
export interface EventView {
  id: string;
  created_at: string;
  node_id: string;
  actor: Actor;
  kind: string;
  data: unknown;
}

/**
 * The data of a `change` event on `/api/events`: what a burst of writes touched. `project_ids` null
 * means anything may have changed. `node_ids` lists the nodes whose own messages, events, links or
 * edges changed, and null means any node in those projects may have.
 */
export interface ChangeNotice {
  project_ids: string[] | null;
  node_ids: string[] | null;
}
