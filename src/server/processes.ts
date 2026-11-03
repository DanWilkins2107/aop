import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const IS_WINDOWS = process.platform === "win32";
const LOOKUP_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
/** How long a process group gets to act on SIGTERM. Windows has no equivalent for console processes. */
const TERM_GRACE_MS = 2_000;

/** Runs a read-only system tool and returns its stdout, or nothing if it failed. Never uses a shell. */
function capture(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done) => {
    execFile(file, args, { windowsHide: true, timeout: LOOKUP_TIMEOUT_MS, ...(env ? { env } : {}) }, (_error, stdout) =>
      // PowerShell exits non-zero when any one ID is missing, and the others are still in stdout.
      done(stdout ?? ""),
    );
  });
}

const powershell = (script: string) => capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When each live process started, as an opaque string to compare against a later reading. A process
 * ID can be reused, but the pair of ID and start time identifies one process. A process that's gone,
 * or that this user can't read, has no entry: treat both as "not confirmed", never as a match.
 */
export async function readProcessStarts(pids: number[]): Promise<Map<number, string>> {
  const live = pids.filter(isAlive);
  const starts = new Map<number, string>();
  if (live.length === 0) return starts;

  if (IS_WINDOWS) {
    const output = await powershell(
      `Get-Process -Id ${live.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() }`,
    );
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\d+) (\d+)$/.exec(line.trim());
      if (match) starts.set(Number(match[1]), match[2] as string);
    }
    return starts;
  }

  // Fixed locale and zone, so that the same process always reads the same.
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
  await Promise.all(
    live.map(async (pid) => {
      const start = (await capture("ps", ["-o", "lstart=", "-p", String(pid)], env)).trim();
      if (start !== "") starts.set(pid, start);
    }),
  );
  return starts;
}

/** A process, as far as it can be told from any other. */
export interface Identity {
  pid: number;
  start: string;
}

/** The processes a process started, by the operating system's parent link. */
export async function readChildren(pid: number): Promise<number[]> {
  const output = IS_WINDOWS
    ? await powershell(`Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { $_.ProcessId }`)
    : await capture("pgrep", ["-P", String(pid)]);
  return output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 0);
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills a process and everything under it. On macOS and Linux every agent leads its own process
 * group. The caller must already know this is the process AOP started.
 */
export async function killTree(pid: number): Promise<void> {
  if (IS_WINDOWS) {
    await capture("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  if (!signalGroup(pid, "SIGTERM")) return;
  const deadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < deadline) {
    await delay(POLL_MS);
    if (!signalGroup(pid, 0)) return;
  }
  signalGroup(pid, "SIGKILL");
}

/** Waits for a process to go. Returns whether it did. */
export async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

/**
 * Kills an agent found again after losing track of it, given which of its processes were confirmed.
 * The shell AOP launched it through can be gone while the agent carries on: Windows ends it when the
 * server dies. So each confirmed process is killed with its own tree on Windows. Elsewhere they share
 * the group the shell led, whose ID can't have been reused while it has members.
 */
export async function killConfirmed(leader: number, confirmed: Identity[]): Promise<void> {
  if (IS_WINDOWS) await Promise.all(confirmed.map(({ pid }) => killTree(pid)));
  else await killTree(leader);
}

/**
 * Clears up anything an agent left running when it exited by itself.
 *
 * - macOS and Linux: the group outlives its leader, and its ID can't be reused while it has members.
 * - Windows: there's no group, so this looks for what the exited processes started, by parent ID. It
 *   runs just after they exit, and keeps only processes younger than the parent, which is what stops
 *   a reused ID's children matching. Only one level is reachable once the parent has gone.
 */
export async function killLeftovers(leader: number, parents: Identity[]): Promise<void> {
  if (!IS_WINDOWS) {
    signalGroup(leader, "SIGKILL");
    return;
  }
  await Promise.all(
    parents.map(async ({ pid, start }) => {
      const output = await powershell(
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToFileTimeUtc() }`,
      );
      const leftovers: number[] = [];
      for (const line of output.split(/\r?\n/)) {
        const match = /^(\d+) (\d+)$/.exec(line.trim());
        if (match && BigInt(match[2] as string) >= BigInt(start)) leftovers.push(Number(match[1]));
      }
      await Promise.all(leftovers.map(killTree));
    }),
  );
}
