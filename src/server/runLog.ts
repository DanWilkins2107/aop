import { appendFileSync, closeSync, createWriteStream, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { refused } from "./errors.js";
import { aopHome } from "./paths.js";

function logsFolder(): string {
  return join(aopHome(), "logs");
}

/**
 * The one place the server writes files of its own: each run's log, under AOP_HOME. Never the config.
 * Only works out the path, so it can't fail: the first write makes the folder.
 */
export function logPathFor(runId: string): string {
  return join(logsFolder(), `${runId}.log`);
}

export function appendToLog(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
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
  for (const path of paths) {
    if (!isRunLog(path)) continue;
    const file = resolve(path);
    try {
      rmSync(file, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.error(error);
    }
  }
}

/** Whether a recorded path is a `.log` file directly in AOP_HOME/logs, the only files AOP reads or deletes as logs. */
export function isRunLog(path: string): boolean {
  const file = resolve(path);
  return dirname(file) === resolve(logsFolder()) && file.endsWith(".log");
}

/**
 * Opens a run's log for reading, or returns null if it's gone. Refuses anything outside
 * AOP_HOME/logs, following links first, so a recorded path can never read another file.
 */
function openRunLog(path: string): number | null {
  if (!isRunLog(path)) throw refused("This run's log isn't in AOP_HOME/logs, so AOP won't read it");
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  let folder: string;
  try {
    folder = realpathSync(logsFolder());
  } catch {
    return null;
  }
  if (dirname(real) !== folder) throw refused("This run's log isn't in AOP_HOME/logs, so AOP won't read it");
  try {
    return openSync(real, "r");
  } catch {
    return null;
  }
}

/** A run's whole log, or null if it's gone. */
export function readRunLog(path: string): string | null {
  const fd = openRunLog(path);
  if (fd === null) return null;
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(size);
    const read = size === 0 ? 0 : readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** How much of a log's end a tail reads. A line longer than this, such as a huge tool result, is skipped. */
const TAIL_BYTES = 1024 * 1024;

/**
 * The complete lines at the end of a run's log, without reading all of it. A line cut off by where
 * the read starts is dropped. Null if the log is gone.
 */
export function readLogEnd(path: string, bytes = TAIL_BYTES): string[] | null {
  const fd = openRunLog(path);
  if (fd === null) return null;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const read = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    if (lines.at(-1) === "") lines.pop();
    return lines;
  } finally {
    closeSync(fd);
  }
}
