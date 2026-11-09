// `aop`. Every command is an HTTP call to the server, except `init` (in `init.ts`) and `serve`, which runs the server in this process.
// `main.ts` runs it on the real process. Tests run it in-process through `runCli`, with their own environment and output.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  RUN_ID_HEADER,
  type ActorRequest,
  type AddProjectRequest,
  type AgentProcessView,
  type ApiErrorBody,
  type ApplyRequest,
  type ApplyResult,
  type CreateNodeRequest,
  type EdgeRequest,
  type EdgeRow,
  type LogTail,
  type NodeView,
  type ProjectRow,
  type ProposalRequest,
  type ProposalView,
  type ReapResult,
  type SteerRequest,
  type SteerSession,
  type WithdrawRequest,
} from "../shared/api.js";
import { API_PREFIX, apiPaths } from "../shared/paths.js";
import { DEFAULT_PORT } from "../shared/port.js";

/** What a run of the CLI reads and writes, instead of the process's own. */
export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Called once, with the exit code, when the command has finished. */
  exit: (code: number) => void;
  /** What `aop propose` reads when it has no `--from`. None means there's nothing to read. */
  stdin?: NodeJS.ReadableStream;
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
export const AGENT_COMMANDS = {
  context: ["aop context [<id>]"],
  "node create": ["aop node create --title ... [--body ...] [--parent ...] [--project ...] [--type ... | --stage ...]"],
  edge: ["aop edge add blocks <from> <to>", "aop edge remove blocks <from> <to>"],
  split: ["aop split start", "aop split finish"],
  propose: ["aop propose <path> [--from <file>]", "aop propose <path> --withdraw"],
  proposals: ["aop proposals [--show <path>]"],
  apply: ["aop apply [--into <checkout>]"],
} as const;
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
const COMMANDS: Record<keyof typeof AGENT_COMMANDS | keyof typeof HUMAN_COMMANDS, Usage> = { ...AGENT_COMMANDS, ...HUMAN_COMMANDS };

const listed = (commands: Record<string, Usage>) =>
  Object.values(commands)
    .flat()
    .map((line) => `  ${line}`)
    .join("\n");

const USAGE = `aop: agent orchestration platform

For agents, acting on AOP_NODE_ID:
${listed(AGENT_COMMANDS)}

For humans:
${listed(HUMAN_COMMANDS)}

Finds the server through AOP_URL, or AOP_PORT on localhost, or else port ${DEFAULT_PORT}.`;

/** A usage error that shows how the command is used, after what was wrong with it if there's more to say. */
const usageError = (usage: Usage, problem?: string) =>
  new UsageError(`${problem === undefined ? "" : `${problem}\n`}Usage: ${usage.join("\n       ")}`);

/** The commands agents use all say so. `actor` is self-reported, and these are the agent's commands. */
const ACTOR = "agent";
/** The human commands say so instead, and always name their node rather than reading AOP_NODE_ID. */
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
  // Set only in a session AOP or `aop steer` opened, so the server can tell this run or session from
  // one that has ended.
  const runId = c.env["AOP_RUN_ID"];
  if (runId) headers[RUN_ID_HEADER] = runId;
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

/** Every route the CLI uses answers JSON, except a node's context. */
async function send<T>(c: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const { type, text } = await call(c, method, path, body);
  if (!type.includes("json")) throw notTheApi(c);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw notTheApi(c);
  }
}

async function sendForText(c: Ctx, path: string): Promise<string> {
  const { type, text } = await call(c, "GET", path);
  if (!type.startsWith("text/plain")) throw notTheApi(c);
  return text;
}

/** The node this session is working on. An agent can only move its own, so it's never an argument. */
function ownNode(c: Ctx): string {
  const id = c.env["AOP_NODE_ID"];
  if (!id) throw new CliFailure("AOP_NODE_ID isn't set. This command only works in a session AOP or `aop steer` opened.");
  return id;
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

const movedTo = (c: Ctx, node: NodeView) => c.log(`${node.id} is now at ${node.stage}`);

async function resolveProject(c: Ctx, reference: string): Promise<string> {
  const projects = await send<ProjectRow[]>(c, "GET", apiPaths.projects);
  const matches = projects.filter((p) => p.id === reference || p.name === reference);
  const [project] = matches;
  if (project === undefined) throw new CliFailure(`No project "${reference}"`);
  if (matches.length > 1) throw new CliFailure(`Several projects are called "${reference}". Use its ID`);
  return project.id;
}

/** Where a new node goes: as named, or else the parent's project, or else this session's. */
async function projectForNewNode(c: Ctx, reference: string | undefined, parent: string | undefined): Promise<string> {
  if (reference !== undefined) return resolveProject(c, reference);
  const nearby = parent ?? c.env["AOP_NODE_ID"];
  if (nearby) return (await send<NodeView>(c, "GET", apiPaths.node(nearby))).project_id;
  throw new CliFailure("Say which project with --project, or --parent, or run this in a session on a node.");
}

async function nodeCommand(c: Ctx, argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  if (action === "create") {
    const usage = COMMANDS["node create"];
    const { values, positionals } = args(rest, usage, {
      title: { type: "string" },
      body: { type: "string" },
      parent: { type: "string" },
      project: { type: "string" },
      type: { type: "string" },
      stage: { type: "string" },
    });
    if (values.title === undefined || positionals.length > 0) {
      throw usageError(usage);
    }
    const project = await projectForNewNode(c, values.project, values.parent);
    const node = await send<NodeView>(c, "POST", apiPaths.projectAction(project, "nodes"), {
      title: values.title,
      actor: ACTOR,
      ...(values.body !== undefined ? { body: values.body } : {}),
      ...(values.parent !== undefined ? { parent_id: values.parent } : {}),
      ...(values.type !== undefined ? { type: values.type } : {}),
      ...(values.stage !== undefined ? { stage: values.stage } : {}),
    } satisfies CreateNodeRequest);
    c.log(`Created ${node.id} at ${node.stage}`);
    return;
  }
  throw usageError(COMMANDS["node create"]);
}

async function edgeCommand(c: Ctx, argv: string[]): Promise<void> {
  const usage = COMMANDS.edge;
  const [action, kind, from, to, ...extra] = args(argv, usage, {}).positionals;
  if (kind !== "blocks" || from === undefined || to === undefined || extra.length > 0) throw usageError(usage);
  if (action === "add") {
    await send(c, "POST", apiPaths.nodeAction(from, "edges"), { target_id: to, kind, actor: ACTOR } satisfies EdgeRequest);
    c.log(`${from} now blocks ${to}`);
    return;
  }
  if (action === "remove") {
    const edges = await send<EdgeRow[]>(c, "GET", apiPaths.nodeAction(from, "edges"));
    const edge = edges.find((e) => e.kind === kind && e.source_id === from && e.target_id === to);
    if (!edge) throw new CliFailure(`${from} doesn't block ${to}`);
    await send(c, "DELETE", apiPaths.edge(edge.id), { actor: ACTOR } satisfies ActorRequest);
    c.log(`${from} no longer blocks ${to}`);
    return;
  }
  throw usageError(usage);
}

async function steerCommand(c: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, COMMANDS.steer, { "no-sandbox": { type: "boolean" } });
  const id = only(positionals, COMMANDS.steer);
  const session = await send<SteerSession>(c, "POST", apiPaths.nodeAction(id, "steer"), { no_sandbox: values["no-sandbox"] === true } satisfies SteerRequest);
  c.log(`Claimed ${id}. Opening a session in ${session.cwd}. Release the claim in the UI or with \`aop release ${id}\` when you're done.`);
  c.log(`Run ID for this session: ${session.steer_id}. Tell your agent to pass it as run_id. It works until you release the claim.`);
  // The command is the user's own config string, which may need a shell. No node text goes in it.
  // A steered session is the human's, not an agent run, even when steered from inside one: its run
  // ID is the session's own, tied to the human's claim.
  const child = spawn(session.command, {
    shell: true,
    cwd: session.cwd,
    stdio: "inherit",
    env: { ...c.env, AOP_NODE_ID: id, AOP_URL: serverUrl(c), AOP_RUN_ID: session.steer_id },
  });
  return new Promise<number>((done, fail) => {
    child.once("error", (error) => fail(new CliFailure(`Couldn't open the session: ${error.message}`)));
    child.once("exit", (code) => done(code ?? 1));
  });
}

/** Stops the agent running on a node, as the UI's Stop run does. The node stays put, claimed by the human. */
async function stopCommand(c: Ctx, argv: string[]): Promise<void> {
  const id = only(args(argv, COMMANDS.stop, {}).positionals, COMMANDS.stop);
  const node = await send<NodeView>(c, "GET", apiPaths.node(id));
  if (node.run_id === null) throw new CliFailure(`No agent is running on ${id}`);
  const stopped = await send<NodeView>(c, "POST", apiPaths.run(node.run_id, "stop"));
  c.log(`Stopped ${node.run_id}. ${id} stays at ${stopped.stage}, claimed by you. Run \`aop release ${id}\` to start the stage again.`);
}

async function releaseCommand(c: Ctx, argv: string[]): Promise<void> {
  const id = only(args(argv, COMMANDS.release, {}).positionals, COMMANDS.release);
  await send<NodeView>(c, "POST", apiPaths.nodeAction(id, "release"), { actor: HUMAN } satisfies ActorRequest);
  c.log(`Released ${id}`);
}

/**
 * Prints the end of the node's latest run's log, as the node page shows it: the agent's readable
 * output, which for stream-json means its text rather than the raw events.
 */
async function logsCommand(c: Ctx, argv: string[]): Promise<void> {
  const usage = COMMANDS.logs;
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

/** A path as the user typed it, made absolute from where the command runs. */
const absolute = (c: Ctx, path: string) => resolve(c.io.cwd ?? process.cwd(), path);

async function readStdin(c: Ctx): Promise<string> {
  const stdin = c.io.stdin;
  if (stdin === undefined || (stdin as { isTTY?: boolean }).isTTY) throw new CliFailure("Pass --from <file>, or pipe the contents in.");
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Stores a file's proposed contents on this improvement. The real file isn't touched. */
async function proposeCommand(c: Ctx, argv: string[]): Promise<void> {
  const usage = COMMANDS.propose;
  const { values, positionals } = args(argv, usage, { from: { type: "string" }, withdraw: { type: "boolean" } });
  const target = absolute(c, only(positionals, usage));
  const proposals = apiPaths.improvementAction(ownNode(c), "proposals");
  if (values.withdraw === true) {
    if (values.from !== undefined) throw usageError(usage);
    await send(c, "DELETE", proposals, { path: target, actor: ACTOR } satisfies WithdrawRequest);
    c.log(`Withdrew the proposal for ${target}`);
    return;
  }
  let content: string;
  if (values.from === undefined) {
    content = await readStdin(c);
  } else {
    try {
      content = readFileSync(absolute(c, values.from), "utf8");
    } catch (error) {
      throw new CliFailure(`Can't read ${values.from}: ${(error as Error).message}`);
    }
  }
  const proposal = await send<ProposalView>(c, "PUT", proposals, { path: target, content, actor: ACTOR } satisfies ProposalRequest);
  c.log(`Proposed ${proposal.path}${proposal.current === null ? " (new file)" : ""}. The real file is unchanged.`);
}

async function proposalsCommand(c: Ctx, argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, COMMANDS.proposals, { show: { type: "string" } });
  if (positionals.length > 0) throw usageError(COMMANDS.proposals);
  const proposals = await send<ProposalView[]>(c, "GET", apiPaths.improvementAction(ownNode(c), "proposals"));
  if (values.show !== undefined) {
    const wanted = absolute(c, values.show).toLowerCase();
    const proposal = proposals.find((p) => p.path.toLowerCase() === wanted || p.display_path === values.show);
    if (!proposal) throw new CliFailure(`No proposal for ${values.show}`);
    c.io.stdout.write(proposal.proposed);
    return;
  }
  if (proposals.length === 0) c.log("No proposals.");
  for (const p of proposals) {
    const what = p.current === null ? "new file" : "changes the file";
    c.log(`${p.path}  (${what}, last by ${p.updated_by}${p.stale ? "; the file has changed since" : ""})`);
  }
}

async function applyCommand(c: Ctx, argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, COMMANDS.apply, { into: { type: "string" } });
  if (positionals.length > 0) throw usageError(COMMANDS.apply);
  const result = await send<ApplyResult>(c, "POST", apiPaths.improvementAction(ownNode(c), "apply"), {
    actor: ACTOR,
    ...(values.into !== undefined ? { into: absolute(c, values.into) } : {}),
  } satisfies ApplyRequest);
  for (const path of result.written) c.log(`Wrote ${path}`);
  for (const path of result.skipped) c.log(`Skipped ${path}: it's outside the repo`);
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
    case "context": {
      const { positionals } = args(rest, COMMANDS.context, {});
      if (positionals.length > 1) throw usageError(COMMANDS.context);
      c.log(await sendForText(c, apiPaths.nodeAction(positionals[0] ?? ownNode(c), "context")));
      return;
    }
    case "node":
      return nodeCommand(c, rest);
    case "edge":
      return edgeCommand(c, rest);
    case "split": {
      const action = only(args(rest, COMMANDS.split, {}).positionals, COMMANDS.split);
      if (action !== "start" && action !== "finish") throw usageError(COMMANDS.split);
      movedTo(c, await send(c, "POST", apiPaths.nodeAction(ownNode(c), `split/${action}`)));
      return;
    }
    case "propose":
      return proposeCommand(c, rest);
    case "proposals":
      return proposalsCommand(c, rest);
    case "apply":
      return applyCommand(c, rest);
    case "project": {
      const [action, path, ...extra] = args(rest, COMMANDS.project, {}).positionals;
      if (action !== "add" || path === undefined || extra.length > 0) throw usageError(COMMANDS.project);
      const project = await send<ProjectRow>(c, "POST", apiPaths.projects, { repo_path: path } satisfies AddProjectRequest);
      c.log(`Added project "${project.name}" (${project.id})`);
      return;
    }
    case "serve": {
      // Loaded here because every other command only talks HTTP, and shouldn't need the database's native module.
      const { runServer } = await import("../server/serve.js");
      // The server belongs to the process, so it prints, and sets the exit code, there.
      await runServer(rest, usageError(COMMANDS.serve).message);
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
      none(rest, COMMANDS.ps);
      printAgents(c, await send<AgentProcessView[]>(c, "GET", apiPaths.agents));
      return;
    case "reap":
      none(rest, COMMANDS.reap);
      printReaped(c, await send<ReapResult>(c, "POST", apiPaths.reap));
      return;
    case "init": {
      const { runInit } = await import("./init.js");
      return runInit(rest, { env: c.env, output: c.io.stdout, errors: c.io.stderr, usage: usageError(COMMANDS.init).message });
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
