import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { runCli } from "../../src/cli/cli.js";
import { nodeArgs } from "../server/agents.helpers.js";

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

/** The CLI in this process, with its own environment and output. Fast: prefer it. */
export async function aopInProcess(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const result: CliResult = { code: null, stdout: "", stderr: "" };
  await runCli({
    argv: args,
    env: cliEnv(env),
    stdout: collect((text) => (result.stdout += text)),
    stderr: collect((text) => (result.stderr += text)),
    exit: (code) => (result.code = code),
  });
  return result;
}

/** The real `aop` entry point in its own process, as an agent would run it. Slow: only for smoke tests. */
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
