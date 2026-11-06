// `aop`. Every command is an HTTP call to the server, except `init` (in `init.ts`) and `serve`, which runs the server in this process.
// `main.ts` runs it on the real process. Tests run it in-process through `runCli`, with their own environment and output.

import { spawn } from "node:child_process";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type {
  AgentProcessView,
  EdgeRow,
  MessageRow,
  NodeView,
  ProjectRow,
  ReapResult,
  SearchResult,
  SteerSession,
} from "../shared/api.js";

/** What a run of the CLI reads and writes, instead of the process's own. */
export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Called once, with the exit code, when the command has finished. */
  exit: (code: number) => void;
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
  next: ["aop next <outcome>"],
  ask: ['aop ask "..."'],
  fail: ['aop fail "<reason>"'],
  message: ['aop message "..." [--node <id>]'],
  link: ["aop link pr|ticket <url>"],
  search: ["aop search <query> [--all]"],
  "node create": ["aop node create --title ... [--body ...] [--parent ...] [--project ...] [--type ... | --stage ...]"],
  "node edit": ["aop node edit [<id>] [--title ...] [--body ...]"],
  edge: ["aop edge add blocks <from> <to>", "aop edge remove blocks <from> <to>"],
  split: ["aop split start", "aop split finish"],
} as const;
export const HUMAN_COMMANDS = {
  init: [
    "aop init [--yes] [--fill-missing] [--agent-session-command <cmd>] [--out-of-sandbox-command <cmd>] [--open-from <dir>] [--create-open-from] [--agent-timeout-minutes <n>] [--stages <file>]",
  ],
  project: ["aop project add <path>"],
  serve: ["aop serve [--port <port>]"],
  steer: ["aop steer <node> [--no-sandbox]"],
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

Finds the server through AOP_URL, or AOP_PORT on localhost, or else port 4317.`;

/** A usage error that shows how the command is used, after what was wrong with it if there's more to say. */
const usageError = (usage: Usage, problem?: string) =>
  new UsageError(`${problem === undefined ? "" : `${problem}\n`}Usage: ${usage.join("\n       ")}`);

const DEFAULT_PORT = "4317";
/** The commands agents use all say so. `actor` is self-reported, and these are the agent's commands. */
const ACTOR = "agent";

class UsageError extends Error {}
class CliFailure extends Error {}

const serverUrl = (c: Ctx) => c.env["AOP_URL"] ?? `http://127.0.0.1:${c.env["AOP_PORT"] ?? DEFAULT_PORT}`;

/** Something answered on the API's address, but not as the API does, such as the web UI's dev server. */
const notTheApi = (c: Ctx) => new CliFailure(`What answered at ${serverUrl(c)} isn't the AOP server's API. Check AOP_URL and AOP_PORT.`);

/** The API's own error, if that's what the body is. */
function apiError(text: string): { message: string; details?: unknown } | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: { message?: unknown; details?: unknown } };
    if (typeof error?.message === "string") return { message: error.message, details: error.details };
  } catch {
    // Not JSON, or JSON null.
  }
  return undefined;
}

/** Calls the API. A failure becomes the API's own message, or else its status. */
async function call(c: Ctx, method: string, path: string, body?: unknown): Promise<{ type: string; text: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${serverUrl(c)}/api${path}`, init);
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

const nodePath = (id: string) => `/nodes/${encodeURIComponent(id)}`;

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
  const projects = await send<ProjectRow[]>(c, "GET", "/projects");
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
  if (nearby) return (await send<NodeView>(c, "GET", nodePath(nearby))).project_id;
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
    const node = await send<NodeView>(c, "POST", `/projects/${encodeURIComponent(project)}/nodes`, {
      title: values.title,
      actor: ACTOR,
      ...(values.body !== undefined ? { body: values.body } : {}),
      ...(values.parent !== undefined ? { parent_id: values.parent } : {}),
      ...(values.type !== undefined ? { type: values.type } : {}),
      ...(values.stage !== undefined ? { stage: values.stage } : {}),
    });
    c.log(`Created ${node.id} at ${node.stage}`);
    return;
  }
  if (action === "edit") {
    const usage = COMMANDS["node edit"];
    const { values, positionals } = args(rest, usage, { title: { type: "string" }, body: { type: "string" } });
    if (positionals.length > 1 || (values.title === undefined && values.body === undefined)) {
      throw usageError(usage);
    }
    const id = positionals[0] ?? ownNode(c);
    await send(c, "PATCH", nodePath(id), {
      actor: ACTOR,
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.body !== undefined ? { body: values.body } : {}),
    });
    c.log(`Edited ${id}`);
    return;
  }
  throw usageError([...COMMANDS["node create"], ...COMMANDS["node edit"]]);
}

async function edgeCommand(c: Ctx, argv: string[]): Promise<void> {
  const usage = COMMANDS.edge;
  const [action, kind, from, to, ...extra] = args(argv, usage, {}).positionals;
  if (kind !== "blocks" || from === undefined || to === undefined || extra.length > 0) throw usageError(usage);
  if (action === "add") {
    await send(c, "POST", `${nodePath(from)}/edges`, { target_id: to, kind, actor: ACTOR });
    c.log(`${from} now blocks ${to}`);
    return;
  }
  if (action === "remove") {
    const edges = await send<EdgeRow[]>(c, "GET", `${nodePath(from)}/edges`);
    const edge = edges.find((e) => e.kind === kind && e.source_id === from && e.target_id === to);
    if (!edge) throw new CliFailure(`${from} doesn't block ${to}`);
    await send(c, "DELETE", `/edges/${encodeURIComponent(edge.id)}`, { actor: ACTOR });
    c.log(`${from} no longer blocks ${to}`);
    return;
  }
  throw usageError(usage);
}

async function searchCommand(c: Ctx, argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, COMMANDS.search, { all: { type: "boolean" } });
  if (positionals.length === 0) throw usageError(COMMANDS.search);
  const query = new URLSearchParams({ q: positionals.join(" ") });
  const own = c.env["AOP_NODE_ID"];
  // With no node there's no current project to narrow to.
  if (values.all !== true && own) query.set("project", (await send<NodeView>(c, "GET", nodePath(own))).project_id);
  const results = await send<SearchResult[]>(c, "GET", `/search?${query}`);
  if (results.length === 0) c.log("No matches.");
  for (const result of results) {
    c.log(`${result.node_id}  [${result.stage}]  ${result.title}`);
    c.log(`    ${result.snippet.replace(/\s+/g, " ")}`);
  }
}

async function steerCommand(c: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, COMMANDS.steer, { "no-sandbox": { type: "boolean" } });
  const id = only(positionals, COMMANDS.steer);
  const session = await send<SteerSession>(c, "POST", `${nodePath(id)}/steer`, { no_sandbox: values["no-sandbox"] === true });
  c.log(`Claimed ${id}. Opening a session in ${session.cwd}. Release the claim in the UI when you're done.`);
  // The command is the user's own config string, which may need a shell. No node text goes in it.
  const child = spawn(session.command, {
    shell: true,
    cwd: session.cwd,
    stdio: "inherit",
    env: { ...c.env, AOP_NODE_ID: id, AOP_URL: serverUrl(c) },
  });
  return new Promise<number>((done, fail) => {
    child.once("error", (error) => fail(new CliFailure(`Couldn't open the session: ${error.message}`)));
    child.once("exit", (code) => done(code ?? 1));
  });
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
      c.log(await sendForText(c, `${nodePath(positionals[0] ?? ownNode(c))}/context`));
      return;
    }
    case "next": {
      const outcome = only(args(rest, COMMANDS.next, {}).positionals, COMMANDS.next);
      movedTo(c, await send(c, "POST", `${nodePath(ownNode(c))}/next`, { outcome, actor: ACTOR }));
      return;
    }
    case "ask": {
      const question = only(args(rest, COMMANDS.ask, {}).positionals, COMMANDS.ask);
      movedTo(c, await send(c, "POST", `${nodePath(ownNode(c))}/ask`, { question }));
      return;
    }
    case "fail": {
      const reason = only(args(rest, COMMANDS.fail, {}).positionals, COMMANDS.fail);
      movedTo(c, await send(c, "POST", `${nodePath(ownNode(c))}/fail`, { reason, actor: ACTOR }));
      return;
    }
    case "message": {
      const { values, positionals } = args(rest, COMMANDS.message, { node: { type: "string" } });
      const body = only(positionals, COMMANDS.message);
      const message = await send<MessageRow>(c, "POST", `${nodePath(values.node ?? ownNode(c))}/messages`, { body, author: ACTOR });
      c.log(`Posted to ${message.node_id}`);
      return;
    }
    case "link": {
      const [kind, url, ...extra] = args(rest, COMMANDS.link, {}).positionals;
      if ((kind !== "pr" && kind !== "ticket") || url === undefined || extra.length > 0) throw usageError(COMMANDS.link);
      await send(c, "POST", `${nodePath(ownNode(c))}/links`, { kind, url, actor: ACTOR });
      c.log(`Linked ${kind} ${url}`);
      return;
    }
    case "search":
      return searchCommand(c, rest);
    case "node":
      return nodeCommand(c, rest);
    case "edge":
      return edgeCommand(c, rest);
    case "split": {
      const action = only(args(rest, COMMANDS.split, {}).positionals, COMMANDS.split);
      if (action !== "start" && action !== "finish") throw usageError(COMMANDS.split);
      movedTo(c, await send(c, "POST", `${nodePath(ownNode(c))}/split/${action}`));
      return;
    }
    case "project": {
      const [action, path, ...extra] = args(rest, COMMANDS.project, {}).positionals;
      if (action !== "add" || path === undefined || extra.length > 0) throw usageError(COMMANDS.project);
      const project = await send<ProjectRow>(c, "POST", "/projects", { repo_path: path });
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
    case "ps":
      none(rest, COMMANDS.ps);
      printAgents(c, await send<AgentProcessView[]>(c, "GET", "/agents"));
      return;
    case "reap":
      none(rest, COMMANDS.reap);
      printReaped(c, await send<ReapResult>(c, "POST", "/agents/reap"));
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
