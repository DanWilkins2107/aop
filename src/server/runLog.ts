import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { aopHome } from "./paths.js";

/** The one place the server writes files of its own: each run's log, under AOP_HOME. Never the config. */
export function logPathFor(runId: string): string {
  const folder = join(aopHome(), "logs");
  mkdirSync(folder, { recursive: true });
  return join(folder, `${runId}.log`);
}

export function appendToLog(path: string, text: string): void {
  appendFileSync(path, text);
}

export function openLog(path: string): WriteStream {
  return createWriteStream(path, { flags: "a" });
}
