import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { runCli } from "../cli.js";
import { fakeCommand, nodeArgs, world, type World } from "../../../test/server/agents.helpers.js";

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The environment a CLI run gets: this process's, without any node or run of its own, plus `env`. */
function cliEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const { AOP_NODE_ID: _node, AOP_RUN_ID: _run, ...outer } = process.env;
  return { ...outer, ...env };
}

const collect = (add: (text: string) => void) =>
  new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      add(chunk.toString());
      done();
    },
  });

/** Where an in-process run starts. */
export interface InProcessOptions {
  cwd?: string;
}

/** The CLI in this process, with its own environment and output. Fast: prefer it. */
export async function aopInProcess(args: string[], env: Record<string, string> = {}, options: InProcessOptions = {}): Promise<CliResult> {
  const result: CliResult = { code: null, stdout: "", stderr: "" };
  await runCli({
    argv: args,
    env: cliEnv(env),
    stdout: collect((text) => (result.stdout += text)),
    stderr: collect((text) => (result.stderr += text)),
    exit: (code) => (result.code = code),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  return result;
}

/** The real `aop` entry point in its own process, as a shell would run it. Slow: only for smoke tests. */
export function aopSpawned(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [...nodeArgs("src/cli/main.ts"), ...args], {
    env: cliEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((done) => child.once("close", (code) => done({ code, stdout, stderr })));
}

/** A fresh world for the commands' tests, whose out-of-sandbox session is a one-line script, so `steer` launches no agent tool. */
export const cliWorld = () => world({ config: `out_of_sandbox_command: ${JSON.stringify(fakeCommand + " --out")}\n` });

/** The CLI in-process against `w`'s server, with AOP_NODE_ID set if `node` is, which no command reads. `main.test.ts` runs the real entry point. */
export const aopOn = (w: World, args: string[], options: { node?: string; env?: Record<string, string> } = {}) =>
  aopInProcess(args, { AOP_URL: w.url, ...(options.node ? { AOP_NODE_ID: options.node } : {}), ...options.env });

/** A node parked at a human stage, so no agent starts on it. */
export const parked = (w: World, extra: Record<string, unknown> = {}) => w.create("", { type: "dev", stage: "pr_review", ...extra });
