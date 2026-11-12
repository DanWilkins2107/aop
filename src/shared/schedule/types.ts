import type { HolderVia } from "../nodes/types.js";

/** A schedule as the node page sets it, in the server's time zone. `time` is `HH:MM`, 24-hour. `days` are 0 (Sunday) to 6 (Saturday), at least one. */
export interface Schedule {
  time: string;
  days: number[];
}

/** Why a scheduled node didn't fire for a slot, with what it names. */
export type ScheduleSkip =
  | { reason: HolderVia; holder_id: string }
  | { reason: "previous_unfinished"; previous_child_id: string }
  | { reason: "child_refused"; message: string };

/** A time of day and the days to fire on, or null for no schedule. */
export type ScheduleRequest = Schedule | null;
