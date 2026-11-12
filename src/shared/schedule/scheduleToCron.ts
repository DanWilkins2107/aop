import type { Schedule } from "./types.js";

const DAYS_IN_WEEK = 7;

/** The cron for a schedule, `M H * * <days>`. Every day is `*`, and other days are listed in order. */
export function scheduleToCron(schedule: Schedule): string {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const days = [...new Set(schedule.days)].sort((a, b) => a - b);
  const dow = days.length === DAYS_IN_WEEK ? "*" : days.join(",");
  return `${minute} ${hour} * * ${dow}`;
}
