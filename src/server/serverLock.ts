import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { aopHome } from "./paths.js";
import { isAlive } from "./processes.js";

/**
 * One server per AOP_HOME. A second one would treat the first's agents as leftovers from a crash and
 * kill them on startup.
 *
 * The lock is an exclusive lock on a small SQLite file, held for as long as the server runs. The
 * operating system drops it when the process ends, however it ends, so a crash can't leave a stale
 * lock behind and there's nothing to clear up or take over. A JSON file beside it names the holder,
 * only so that a refusal can say which server is running. It's never trusted for the lock itself.
 */
const LOCK_FILE = "server.lock";
const HOLDER_FILE = "server.json";

export class ServerAlreadyRunning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerAlreadyRunning";
  }
}

interface Holder {
  pid: number;
  url: string | null;
  started_at: string;
}

export interface ServerLock {
  /** Records where this server is listening, for a refusal to name. */
  setUrl(url: string): void;
  /** Ends this server's hold. Also happens by itself when the process ends. */
  release(): void;
}

export function acquireServerLock(home: string = aopHome()): ServerLock {
  const lockPath = join(home, LOCK_FILE);
  const holderPath = join(home, HOLDER_FILE);
  // No busy timeout: a held lock means a running server, so waiting would only delay the refusal.
  const lock = new Database(lockPath, { timeout: 0 });
  try {
    lock.pragma("locking_mode = EXCLUSIVE");
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") throw new ServerAlreadyRunning(refusal(home, holderPath));
    throw error;
  }

  const holder: Holder = { pid: process.pid, url: null, started_at: new Date().toISOString() };
  const writeHolder = () => writeFileSync(holderPath, `${JSON.stringify(holder)}\n`);
  writeHolder();
  let held = true;
  return {
    setUrl(url) {
      holder.url = url;
      if (held) writeHolder();
    },
    release() {
      if (!held) return;
      held = false;
      if (readHolder(holderPath)?.pid === process.pid) rmSync(holderPath, { force: true });
      lock.close();
    },
  };
}

function readHolder(path: string): Holder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>;
    return typeof parsed.pid === "number" && typeof parsed.started_at === "string"
      ? { pid: parsed.pid, url: typeof parsed.url === "string" ? parsed.url : null, started_at: parsed.started_at }
      : null;
  } catch {
    return null;
  }
}

function refusal(home: string, holderPath: string): string {
  const holder = readHolder(holderPath);
  // The file is only a description, and may be from an earlier server, or not written yet.
  const who =
    holder && isAlive(holder.pid)
      ? `process ${holder.pid}${holder.url ? ` at ${holder.url}` : ", still starting up"}, started ${holder.started_at}`
      : "a server whose details aren't available yet";
  return (
    `Another AOP server is already running with AOP_HOME ${home}: ${who}.\n` +
    "Stop that one first, or set AOP_HOME to a different folder to run a separate AOP."
  );
}
