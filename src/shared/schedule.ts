/**
 * A scheduled node's schedule as the node page sets it: a time of day and the days of the week to
 * fire on, in the server's time zone. It's stored as a cron, `M H * * <days>`. Plain functions with
 * no imports, so that the browser can use this file too.
 */

/** `time` is `HH:MM`, 24-hour. `days` are 0 (Sunday) to 6 (Saturday), at least one. */
export interface Schedule {
  time: string;
  days: number[];
}

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** The cron for a schedule. Every day is `*`, and other days are listed in order. */
export function scheduleToCron(schedule: Schedule): string {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const days = [...new Set(schedule.days)].sort((a, b) => a - b);
  const dow = days.length === EVERY_DAY.length ? "*" : days.join(",");
  return `${minute} ${hour} * * ${dow}`;
}

/** The schedule a cron stands for, or null if it isn't one the time-and-days picker could have made. */
export function cronToSchedule(cron: string): Schedule | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(cron.trim());
  if (match === null) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const days = match[3] === "*" ? EVERY_DAY : [...new Set(match[3]!.split(",").map(Number))].sort((a, b) => a - b);
  return { time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, days };
}
