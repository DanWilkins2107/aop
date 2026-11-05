import { Cron } from "croner";

/** Parses a five-field cron, read in the server's local time zone. Throws if it's invalid. */
export function parseCron(cron: string): Cron {
  return new Cron(cron.trim(), { paused: true, mode: "5-part" });
}

/** Why a cron expression is unusable, or null if it's fine. */
export function cronProblem(cron: string): string | null {
  try {
    return parseCron(cron).nextRun() === null ? "it never fires" : null;
  } catch (error) {
    return (error as Error).message.replace(/^CronPattern: /, "");
  }
}
