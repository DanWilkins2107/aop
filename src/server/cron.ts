import { Cron } from "croner";

/** Parses a five-field cron, read in the server's local time zone. Throws if it's invalid. */
export function parseCron(cron: string): Cron {
  return new Cron(cron.trim(), { paused: true, mode: "5-part" });
}

/** When a cron next fires after `from`, or null if it's unusable or never fires. */
export function nextFireAt(cron: string, from: Date = new Date()): string | null {
  try {
    return parseCron(cron).nextRun(from)?.toISOString() ?? null;
  } catch {
    return null;
  }
}
