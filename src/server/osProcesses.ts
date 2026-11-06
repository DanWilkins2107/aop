// Operating system processes: start times, children, kills and the run-marker sweep. Knows nothing about
// nodes or runs. Not to be confused with `processView.ts`, which is about the process in `stages.yaml`.

import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
 * - Every platform: whatever still carries the run's marker, and on Windows what those started. See
 *   `sweepRuns`. That's the whole tree, however deep, and however its parent links have broken.
 * - macOS and Linux: also the group, which outlives its leader, and whose ID can't be reused while it
 *   has members.
 * - Windows: also what the exited processes started, by parent ID, for a child that cleared its
 *   environment. It runs just after they exit, and keeps only processes younger than the parent,
 *   which is what stops a reused ID's children matching.
 */
export async function killLeftovers(runId: string, leader: number, parents: Identity[]): Promise<void> {
  if (!IS_WINDOWS) signalGroup(leader, "SIGKILL");
  await Promise.all([
    sweepRuns([runId], true),
    ...(IS_WINDOWS
      ? parents.map(async ({ pid, start }) => {
          const output = await powershell(
            `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToFileTimeUtc() }`,
          );
          const leftovers: number[] = [];
          for (const line of output.split(/\r?\n/)) {
            const match = /^(\d+) (\d+)$/.exec(line.trim());
            if (match && BigInt(match[2] as string) >= BigInt(start)) leftovers.push(Number(match[1]));
          }
          await Promise.all(leftovers.map(killTree));
        })
      : []),
  ]);
}

/**
 * The environment variable that marks every process of a run, set on the launched process and
 * inherited by everything it starts. Its value is the run's ID, which is random, so a match can only
 * be a process from that run, whatever happened to its parent links or the process IDs on record.
 */
export const RUN_MARKER = "AOP_RUN_ID";

const RUN_ID = /^[0-9a-f-]{36}$/i;

/** A process found by its run's marker. */
export interface MarkedProcess {
  pid: number;
  runId: string;
}

/**
 * Finds every process carrying one of these runs' markers, and kills them if asked. Returns null where
 * that can't be done, so the caller falls back to what's on record.
 *
 * - Windows: reads each process's environment block. It also takes in each marked process's
 *   descendants, by parent ID and younger than their parent, for any that cleared their environment.
 *   Each process is held open from being read to being killed, so its ID can't be reused in between.
 *   Only 64-bit processes this user can read are seen.
 * - Linux: reads `/proc/<pid>/environ`. Not verified by the tests here, which run on Windows.
 * - macOS: there's no reliable way to read another process's environment, so this returns null.
 *
 * Never matches this server's own process.
 */
export async function sweepRuns(runIds: string[], kill: boolean): Promise<MarkedProcess[] | null> {
  const ids = runIds.filter((id) => RUN_ID.test(id));
  if (ids.length === 0) return [];
  if (IS_WINDOWS) return sweepWindows(ids, kill);
  if (process.platform === "linux") return sweepLinux(ids, kill);
  return null;
}

function sweepLinux(ids: string[], kill: boolean): MarkedProcess[] | null {
  const wanted = new Set(ids);
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  const found: MarkedProcess[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "latin1");
    } catch {
      continue; // Gone, or not this user's.
    }
    const value = environ
      .split("\0")
      .find((entry) => entry.startsWith(`${RUN_MARKER}=`))
      ?.slice(RUN_MARKER.length + 1);
    if (value !== undefined && wanted.has(value)) found.push({ pid, runId: value });
  }
  if (kill) {
    for (const { pid } of found) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  return found;
}

/** See `sweepRuns`. Compiled once per server, by `SweepHelper`. */
const SWEEP_SOURCE = String.raw`
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class AopSweep {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr exit, peb, affinity, priority, pid, ppid; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr at, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int kind, ref Basic info, int size, out int written);

  static IntPtr ReadPointer(IntPtr h, IntPtr at) {
    var buffer = new byte[8]; IntPtr read;
    return ReadProcessMemory(h, at, buffer, (IntPtr)8, out read) ? (IntPtr)BitConverter.ToInt64(buffer, 0) : IntPtr.Zero;
  }

  static string Marker(IntPtr h) {
    bool wow;
    if (!IsWow64Process(h, out wow) || wow) return null;
    var info = new Basic(); int written;
    if (NtQueryInformationProcess(h, 0, ref info, Marshal.SizeOf(info), out written) != 0 || info.peb == IntPtr.Zero) return null;
    IntPtr parameters = ReadPointer(h, info.peb + 0x20);
    if (parameters == IntPtr.Zero) return null;
    IntPtr env = ReadPointer(h, parameters + 0x80);
    long size = (long)ReadPointer(h, parameters + 0x3F0);
    if (env == IntPtr.Zero || size <= 0) return null;
    if (size > (1 << 20)) size = 1 << 20;
    var block = new byte[size]; IntPtr got;
    if (!ReadProcessMemory(h, env, block, (IntPtr)size, out got)) return null;
    foreach (var entry in Encoding.Unicode.GetString(block, 0, (int)got).Split('\0'))
      if (entry.StartsWith("AOP_RUN_ID=", StringComparison.OrdinalIgnoreCase)) return entry.Substring(11);
    return null;
  }

  public static string Run(string[] ids, bool kill, uint exclude) {
    if (IntPtr.Size != 8) return "";
    var wanted = new HashSet<string>(ids, StringComparer.OrdinalIgnoreCase);
    var parent = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == (IntPtr)(-1)) return "";
    var e = new Entry(); e.size = (uint)Marshal.SizeOf(typeof(Entry));
    for (bool more = Process32FirstW(snap, ref e); more; more = Process32NextW(snap, ref e)) parent[e.pid] = e.ppid;
    CloseHandle(snap);

    uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    var handles = new Dictionary<uint, IntPtr>();
    var created = new Dictionary<uint, long>();
    var run = new Dictionary<uint, string>();
    try {
      foreach (uint pid in parent.Keys) {
        if (pid <= 4 || pid == self || pid == exclude) continue;
        IntPtr h = OpenProcess(0x1 | 0x10 | 0x1000, false, pid);
        if (h == IntPtr.Zero) h = OpenProcess(0x10 | 0x1000, false, pid);
        if (h == IntPtr.Zero) continue;
        long c, x, k, u;
        if (!GetProcessTimes(h, out c, out x, out k, out u)) { CloseHandle(h); continue; }
        handles[pid] = h; created[pid] = c;
        string marker = Marker(h);
        if (marker != null && wanted.Contains(marker)) run[pid] = marker;
      }
      // What a marked process started, however deep, if it's younger than its parent: an older one
      // only has that parent ID because the ID was reused.
      for (bool grew = true; grew; ) {
        grew = false;
        foreach (uint pid in handles.Keys) {
          uint up;
          if (run.ContainsKey(pid) || !parent.TryGetValue(pid, out up) || !run.ContainsKey(up) || !created.ContainsKey(up)) continue;
          if (created[pid] < created[up]) continue;
          run[pid] = run[up]; grew = true;
        }
      }
      var output = new StringBuilder();
      foreach (var found in run) {
        if (kill) TerminateProcess(handles[found.Key], 1);
        output.Append(found.Key).Append(' ').Append(found.Value).Append('\n');
      }
      return output.ToString();
    } finally {
      foreach (IntPtr h in handles.Values) CloseHandle(h);
    }
  }
}
`;

const SWEEP_DONE = "AOP-SWEEP-DONE";
const SWEEP_FAILED = "AOP-SWEEP-FAILED";
/** Allows for compiling on first use, on a busy machine. */
const SWEEP_TIMEOUT_MS = 60_000;

/**
 * One PowerShell process that compiles the sweep once and then answers a request per line, because
 * compiling takes seconds and a sweep follows every agent's exit. It's a plain child of the server,
 * which Node on Windows puts in a job that ends it when the server ends, however that happens. It
 * doesn't keep the server running, and it's started again if it dies.
 */
class SweepHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private output = "";
  private waiting: ((output: string | null) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Requests waiting their turn, merged into one, because several runs often end together. */
  private batch: { ids: Set<string>; kill: boolean; answer: Promise<string | null> } | null = null;

  /** Answers for every run in the batch it joins, not only these. */
  request(ids: string[], kill: boolean): Promise<string | null> {
    if (this.batch?.kill === kill) {
      for (const id of ids) this.batch.ids.add(id);
      return this.batch.answer;
    }
    const batch = { ids: new Set(ids), kill, answer: Promise.resolve<string | null>(null) };
    batch.answer = this.queue.then(() => {
      if (this.batch === batch) this.batch = null;
      return this.send(`${kill ? "kill" : "find"} ${[...batch.ids].join(",")}\n`);
    });
    this.batch = batch;
    this.queue = batch.answer.catch(() => {});
    return batch.answer;
  }

  /** Starts compiling now, so that the first real request doesn't wait for it. */
  warm(): void {
    this.child ??= this.start();
  }

  private start(): ChildProcessWithoutNullStreams {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Add-Type -TypeDefinition @'\n${SWEEP_SOURCE}\n'@`,
      "while ($null -ne ($line = [Console]::In.ReadLine())) {",
      "  $parts = $line.Split(' ')",
      `  try { [Console]::Out.Write([AopSweep]::Run($parts[1].Split(','), $parts[0] -eq 'kill', ${process.pid})); [Console]::Out.WriteLine('${SWEEP_DONE}') }`,
      `  catch { [Console]::Out.WriteLine('${SWEEP_FAILED}') }`,
      "  [Console]::Out.Flush()",
      "}",
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: "pipe",
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.output += chunk;
      const end = /^(AOP-SWEEP-DONE|AOP-SWEEP-FAILED)\r?$/m.exec(this.output);
      if (!end) return;
      const answer = end[1] === SWEEP_DONE ? this.output.slice(0, end.index) : null;
      this.output = this.output.slice(end.index + end[0].length).replace(/^\n/, "");
      this.answer(answer);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("exit", () => {
      if (this.child === child) this.child = null;
      this.answer(null);
    });
    child.once("error", () => {
      if (this.child === child) this.child = null;
      this.answer(null);
    });
    for (const stream of [child, child.stdin, child.stdout, child.stderr] as unknown as { unref?: () => void }[]) stream.unref?.();
    return child;
  }

  private answer(output: string | null): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.(output);
  }

  private send(line: string): Promise<string | null> {
    this.child ??= this.start();
    const child = this.child;
    this.output = "";
    return new Promise((done) => {
      const timer = setTimeout(() => {
        // Stuck: start afresh next time, and know nothing this time.
        child.kill();
        this.answer(null);
      }, SWEEP_TIMEOUT_MS);
      timer.unref();
      this.waiting = (output) => {
        clearTimeout(timer);
        done(output);
      };
      child.stdin.write(line);
    });
  }
}

let sweepHelper: SweepHelper | null = null;

/** Gets sweeps ready ahead of the first one, where that takes time. */
export function prepareSweeps(): void {
  if (!IS_WINDOWS) return;
  sweepHelper ??= new SweepHelper();
  sweepHelper.warm();
}

async function sweepWindows(ids: string[], kill: boolean): Promise<MarkedProcess[] | null> {
  sweepHelper ??= new SweepHelper();
  const output = await sweepHelper.request(ids, kill);
  // PowerShell or the compiler failed, and nothing is known.
  if (output === null) return null;
  const found: MarkedProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+) (\S+)$/.exec(line.trim());
    if (match) found.push({ pid: Number(match[1]), runId: match[2] as string });
  }
  return found;
}
