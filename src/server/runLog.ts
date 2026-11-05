import { appendFileSync, createWriteStream, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { aopHome } from "./paths.js";

function logsFolder(): string {
  return join(aopHome(), "logs");
}

/** The one place the server writes files of its own: each run's log, under AOP_HOME. Never the config. */
export function logPathFor(runId: string): string {
  const folder = logsFolder();
  mkdirSync(folder, { recursive: true });
  return join(folder, `${runId}.log`);
}

export function appendToLog(path: string, text: string): void {
  appendFileSync(path, text);
}

export function openLog(path: string): WriteStream {
  return createWriteStream(path, { flags: "a" });
}

/**
 * Deletes run logs, such as a deleted project's, once nothing writes to them. Only ever `.log` files
 * directly in AOP_HOME/logs: a recorded path that points anywhere else is left alone. A log that can't
 * be deleted is reported and skipped, because by then the project has gone either way.
 */
export function deleteLogs(paths: string[]): void {
  const folder = resolve(logsFolder());
  for (const path of paths) {
    const file = resolve(path);
    if (dirname(file) !== folder || !file.endsWith(".log")) continue;
    try {
      rmSync(file, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.error(error);
    }
  }
}
