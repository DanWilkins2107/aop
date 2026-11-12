// `aop`. Every command is an HTTP call to the server, except `init` (in `init.ts`) and `serve`, which runs the server in this process.
// `main.ts` runs it on the real process. Tests run it in-process through `runCli`, with their own environment and output.

import { spawn } from "node:child_process";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  type ActorRequest,
  type AddProjectRequest,
  type AgentProcessView,
  type ApiErrorBody,
  type LogTail,
  type NodeView,
  type ProjectRow,
  type ReapResult,
  type SteerRequest,
  type SteerSession,
} from "../shared/api/types.js";
import { API_PREFIX, apiPaths } from "../shared/api/paths.js";
import { DEFAULT_PORT, MCP_PORT } from "../shared/api/port.js";

/** What a run of the CLI reads and writes, instead of the process's own. */
export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Called once, with the exit code, when the command has finished. */
  exit: (code: number) => void;
  /** Where relative paths start. The process's own working directory if left out. */
  cwd?: string;
}

/** One run: its environment, and where it prints. */
interface Ctx {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  log: (text: string) => void;
}

/** Each command's usage, for both the help and its own usage errors, so the two can't drift apart. */
export const HUMAN_COMMANDS = {
  init: [
    "aop init [--yes] [--fill-missing] [--if-new] [--agent-session-command <cmd>] [--out-of-sandbox-command <cmd>] [--open-from <dir>] [--create-open-from] [--agent-timeout-minutes <n>] [--stages <file>] [--improvements-path <dir>]",
  ],
  project: ["aop project add <path>"],
  serve: ["aop serve [--port <port>]"],
  steer: ["aop steer <node> [--no-sandbox]"],
  stop: ["aop stop <node>"],
  release: ["aop release <node>"],
  logs: ["aop logs <node> [--lines N]"],
  ps: ["aop ps"],
  reap: ["aop reap"],
} as const;
type Usage = readonly string[];

const listed = (commands: Record<string, Usage>) =>
  Object.values(commands)
    .flat()
    .map((line) => `  ${line}`)
    .join("\n");

const USAGE = `aop: agent orchestration platform

${listed(HUMAN_COMMANDS)}

Agents use AOP's MCP server at http://127.0.0.1:${MCP_PORT}/mcp.

Finds the server through AOP_URL, or AOP_PORT on localhost, or else port ${DEFAULT_PORT}.`;

/** A usage error that shows how the command is used, after what was wrong with it if there's more to say. */
const usageError = (usage: Usage, problem?: string) =>
  new UsageError(`${problem === undefined ? "" : `${problem}\n`}Usage: ${usage.join("\n       ")}`);

/** Every command is a human's, and names its node. `actor` is self-reported. */
const HUMAN = "human";
/** How much of a log `aop logs` prints unless asked for more or less. */
const DEFAULT_LOG_LINES = 50;

class UsageError extends Error {}
class CliFailure extends Error {}

const serverUrl = (c: Ctx) => c.env["AOP_URL"] ?? `http://127.0.0.1:${c.env["AOP_PORT"] ?? DEFAULT_PORT}`;

/** Something answered on the API's address, but not as the API does, such as the web UI's dev server. */
const notTheApi = (c: Ctx) => new CliFailure(`What answered at ${serverUrl(c)} isn't the AOP server's API. Check AOP_URL and AOP_PORT.`);

/** The API's own error, if that's what the body is. */
function apiError(text: string): { message: string; details?: unknown } | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: Partial<ApiErrorBody["error"]> };
    if (typeof error?.message === "string") return { message: error.message, details: error.details };
  } catch {
    // Not JSON, or JSON null.
  }
  return undefined;
}

/** Calls the API. A failure becomes the API's own message, or else its status. */
async function call(c: Ctx, method: string, path: string, body?: unknown): Promise<{ type: string; text: string }> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  // No run ID, even where AOP_RUN_ID is set: every command is the human's, not the run's or session's.
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${serverUrl(c)}${API_PREFIX}${path}`, init);
  } catch {
    throw new CliFailure(`Can't reach the AOP server at ${serverUrl(c)}. Is \`aop serve\` running?`);
  }
  const text = await response.text();
  if (!response.ok) {
    const error = apiError(text);
    let message = error?.message ?? `The server answered ${response.status}`;
    if (error?.details !== undefined) message += `\n${JSON.stringify(error.details)}`;
    throw new CliFailure(message);
  }
  return { type: response.headers.get("content-type") ?? "", text };
}

/** Every route the CLI uses answers JSON. */
async function send<T>(c: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const { type, text } = await call(c, method, path, body);
  if (!type.includes("json")) throw notTheApi(c);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw notTheApi(c);
  }
}

/** Reads the options of one command. A bad option is a usage error, not a stack trace. */
function args<T extends NonNullable<ParseArgsConfig["options"]>>(argv: string[], usage: Usage, options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError(usage, (error as Error).message);
  }
}

function only<T>(values: T[], usage: Usage): T {
  const [value] = values;
  if (value === undefined || values.length !== 1) throw usageError(usage);
  return value;
}

/** For commands that take no arguments at all. */
function none(argv: string[], usage: Usage): void {
  if (args(argv, usage, {}).positionals.length > 0) throw usageError(usage);
}


async function steerCommand(c: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, HUMAN_COMMANDS.steer, { "no-sandbox": { type: "boolean" } });
  const id = only(positionals, HUMAN_COMMANDS.steer);
  const session = await send<SteerSession>(c, "POST", apiPaths.nodeAction(id, "steer"), { no_sandbox: values["no-sandbox"] === true } satisfies SteerRequest);
  c.log(`Claimed ${id}. Opening a session in ${session.cwd}. Release the claim in the UI or with \`aop release ${id}\` when you're done.`);
  c.log(`Run ID for this session: ${session.steer_id}. Tell your agent to pass it as run_id, with ${id} as node_id. It works until you release the claim.`);
  // The command is the user's own config string, which may need a shell. No node text goes in it.
  // A steered session is the human's, not an agent run, even when steered from inside one: its run
  // ID is the session's own, tied to the human's claim. AOP_URL is for any `aop` the human runs there.
  const child = spawn(session.command, {
    shell: true,
    cwd: session.cwd,
    stdio: "inherit",
    env: { ...c.env, AOP_URL: serverUrl(c), AOP_RUN_ID: session.steer_id },
  });
  return new Promise<number>((done, fail) => {
    child.once("error", (error) => fail(new CliFailure(`Couldn't open the session: ${error.message}`)));
    child.once("exit", (code) => done(code ?? 1));
  });
}

/** Stops the agent running on a node, as the UI's Stop run does. The node stays put, claimed by the human. */
async function stopCommand(c: Ctx, argv: string[]): Promise<void> {
  const id = only(args(argv, HUMAN_COMMANDS.stop, {}).positionals, HUMAN_COMMANDS.stop);
  const node = await send<NodeView>(c, "GET", apiPaths.node(id));
  if (node.run_id === null) throw new CliFailure(`No agent is running on ${id}`);
  const stopped = await send<NodeView>(c, "POST", apiPaths.run(node.run_id, "stop"));
  c.log(`Stopped ${node.run_id}. ${id} stays at ${stopped.stage}, claimed by you. Run \`aop release ${id}\` to start the stage again.`);
}

async function releaseCommand(c: Ctx, argv: string[]): Promise<void> {
  const id = only(args(argv, HUMAN_COMMANDS.release, {}).positionals, HUMAN_COMMANDS.release);
  await send<NodeView>(c, "POST", apiPaths.nodeAction(id, "release"), { actor: HUMAN } satisfies ActorRequest);
  c.log(`Released ${id}`);
}

/**
 * Prints the end of the node's latest run's log, as the node page shows it: the agent's readable
 * output, which for stream-json means its text rather than the raw events.
 */
async function logsCommand(c: Ctx, argv: string[]): Promise<void> {
  const usage = HUMAN_COMMANDS.logs;
  const { values, positionals } = args(argv, usage, { lines: { type: "string" } });
  const id = only(positionals, usage);
  const lines = values.lines === undefined ? DEFAULT_LOG_LINES : Number(values.lines);
  if (!Number.isInteger(lines) || lines < 1) throw usageError(usage, "--lines must be a whole number above 0");
  const node = await send<NodeView>(c, "GET", apiPaths.node(id));
  if (node.last_run_id === null) throw new CliFailure(`${id} has had no runs yet`);
  const tail = await send<LogTail>(c, "GET", `${apiPaths.run(node.last_run_id, "tail")}?lines=${lines}`);
  if (tail.lines.length === 0) {
    c.log(`The log for ${node.last_run_id} is empty so far.`);
    return;
  }
  c.log(tail.lines.join("\n"));
}


function printAgents(c: Ctx, agents: AgentProcessView[]): void {
  if (agents.length === 0) {
    c.log("No agents running.");
    return;
  }
  for (const agent of agents) {
    const identity = agent.identity === "confirmed" ? "" : "  (unverified)";
    const where = agent.node_title === null ? "(node deleted)" : `[${agent.stage}] ${agent.node_title}`;
    c.log(`${agent.run_id}  pid ${agent.pid}  ${agent.status}${identity}  node ${agent.node_id}  ${where}`);
  }
}

function printReaped(c: Ctx, result: ReapResult): void {
  if (result.killed.length === 0) c.log("Nothing to reap.");
  for (const { run_id, pid, reason } of result.killed) c.log(`Killed ${run_id} (pid ${pid}): ${reason}`);
  for (const { run_id, pid, reason } of result.skipped) c.log(`Left alone ${run_id} (pid ${pid}): ${reason}`);
}

/** Runs a command, and gives its exit code when it isn't 0. */
async function run(c: Ctx, argv: string[]): Promise<number | void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      c.log(USAGE);
      return;
    case "project": {
      const [action, path, ...extra] = args(rest, HUMAN_COMMANDS.project, {}).positionals;
      if (action !== "add" || path === undefined || extra.length > 0) throw usageError(HUMAN_COMMANDS.project);
      const project = await send<ProjectRow>(c, "POST", apiPaths.projects, { repo_path: path } satisfies AddProjectRequest);
      c.log(`Added project "${project.name}" (${project.id})`);
      return;
    }
    case "serve": {
      // Loaded here because every other command only talks HTTP, and shouldn't need the database's native module.
      const { runServer } = await import("../server/serve.js");
      // The server belongs to the process, so it prints, and sets the exit code, there.
      await runServer(rest, usageError(HUMAN_COMMANDS.serve).message);
      return Number(process.exitCode ?? 0);
    }
    case "steer":
      return steerCommand(c, rest);
    case "stop":
      return stopCommand(c, rest);
    case "release":
      return releaseCommand(c, rest);
    case "logs":
      return logsCommand(c, rest);
    case "ps":
      none(rest, HUMAN_COMMANDS.ps);
      printAgents(c, await send<AgentProcessView[]>(c, "GET", apiPaths.agents));
      return;
    case "reap":
      none(rest, HUMAN_COMMANDS.reap);
      printReaped(c, await send<ReapResult>(c, "POST", apiPaths.reap));
      return;
    case "init": {
      const { runInit } = await import("./init.js");
      return runInit(rest, { env: c.env, output: c.io.stdout, errors: c.io.stderr, usage: usageError(HUMAN_COMMANDS.init).message });
    }
    default:
      throw new UsageError(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

/** Runs one `aop` command. A usage or command failure is printed and becomes the exit code; anything else is thrown. */
export async function runCli(io: CliIo): Promise<void> {
  const c: Ctx = { env: io.env, io, log: (text) => io.stdout.write(`${text}\n`) };
  let code: number;
  try {
    code = (await run(c, io.argv)) ?? 0;
  } catch (error) {
    if (error instanceof UsageError) code = 2;
    else if (error instanceof CliFailure) code = 1;
    else throw error;
    io.stderr.write(`${error.message}\n`);
  }
  io.exit(code);
}
