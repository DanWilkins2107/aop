// How a scheduled node's schedule reads on the node page and in its history.
import { cronToSchedule, type Schedule } from "../../../src/shared/domain/schedule.js";

/** The days in the order the page shows them, Monday first. Values are cron's, 0 for Sunday. */
export const WEEK: readonly { day: number; short: string; long: string }[] = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 0, short: "Sun", long: "Sunday" },
];

/** "09:30 on Mon, Wed, Fri", or "every day at 03:00". */
function timeAndDays(schedule: Schedule): string {
  const days = WEEK.filter(({ day }) => schedule.days.includes(day));
  if (days.length === WEEK.length) return `every day at ${schedule.time}`;
  return `${schedule.time} on ${days.map(({ short }) => short).join(", ")}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the node page says about a schedule: in words, or the raw cron if the picker couldn't have made it. */
export function describeSchedule(cron: string | null): string {
  if (cron === null) return "No schedule: this node won't fire.";
  const schedule = cronToSchedule(cron);
  if (schedule === null) return `Fires on the cron ${cron}.`;
  const words = timeAndDays(schedule);
  return schedule.days.length === WEEK.length ? `${capitalize(words)}.` : `Fires at ${words}.`;
}

/** The history line for a schedule change. */
export function describeScheduleChange(cron: string | null): string {
  if (cron === null) return "Schedule cleared";
  const schedule = cronToSchedule(cron);
  return `Schedule set: ${schedule === null ? cron : timeAndDays(schedule)}`;
}

/** The picker's starting values: the node's schedule if it has one the picker can show, or 09:00 on weekdays. */
export function pickerStart(cron: string | null): Schedule {
  return (cron === null ? null : cronToSchedule(cron)) ?? { time: "09:00", days: [1, 2, 3, 4, 5] };
}
