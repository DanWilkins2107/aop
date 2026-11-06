#!/usr/bin/env node
// `aop`. Every command is an HTTP call to the server, except `init` (in `init.ts`) and `serve`, which runs the server in this process.

import { spawn } from "node:child_process";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type {
  ActorRequest,
  AddProjectRequest,
  AgentProcessView,
  ApiErrorBody,
  AskRequest,
  CreateNodeRequest,
  EdgeRequest,
  EdgeRow,
  EditNodeRequest,
  FailRequest,
  LinkRequest,
  LogTail,
  MessageRequest,
  MessageRow,
  NextRequest,
  NodeView,
  ProjectRow,
  ReapResult,
  SearchResult,
  SteerRequest,
  SteerSession,
} from "../shared/api.js";
import { API_PREFIX, apiPaths } from "../shared/paths.js";

/** Each command's usage, for both the help and its own usage errors, so the two can't drift apart. */
const AGENT_COMMANDS = {
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
const HUMAN_COMMANDS = {
  init: [
    "aop init [--yes] [--fill-missing] [--agent-session-command <cmd>] [--out-of-sandbox-command <cmd>] [--open-from <dir>] [--create-open-from] [--agent-timeout-minutes <n>] [--stages <file>]",
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

Finds the server through AOP_URL, or AOP_PORT on localhost, or else port 4317.`;

/** A usage error that shows how the command is used, after what was wrong with it if there's more to say. */
const usageError = (usage: Usage, problem?: string) =>
  new UsageError(`${problem === undefined ? "" : `${problem}\n`}Usage: ${usage.join("\n       ")}`);

const DEFAULT_PORT = "4317";
/** The commands agents use all say so. `actor` is self-reported, and these are the agent's commands. */
const ACTOR = "agent";
/** The human commands say so instead, and always name their node rather than reading AOP_NODE_ID. */
const HUMAN = "human";
/** How much of a log `aop logs` prints unless asked for more or less. */
const DEFAULT_LOG_LINES = 50;

class UsageError extends Error {}
class CliFailure extends Error {}

const serverUrl = () => process.env["AOP_URL"] ?? `http://127.0.0.1:${process.env["AOP_PORT"] ?? DEFAULT_PORT}`;

/** Something answered on the API's address, but not as the API does, such as the web UI's dev server. */
const notTheApi = () => new CliFailure(`What answered at ${serverUrl()} isn't the AOP server's API. Check AOP_URL and AOP_PORT.`);

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
async function call(method: string, path: string, body?: unknown): Promise<{ type: string; text: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${serverUrl()}${API_PREFIX}${path}`, init);
  } catch {
    throw new CliFailure(`Can't reach the AOP server at ${serverUrl()}. Is \`aop serve\` running?`);
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
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { type, text } = await call(method, path, body);
  if (!type.includes("json")) throw notTheApi();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw notTheApi();
  }
}

async function sendForText(path: string): Promise<string> {
  const { type, text } = await call("GET", path);
  if (!type.startsWith("text/plain")) throw notTheApi();
  return text;
}

/** The node this session is working on. An agent can only move its own, so it's never an argument. */
function ownNode(): string {
  const id = process.env["AOP_NODE_ID"];
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

const movedTo = (node: NodeView) => console.log(`${node.id} is now at ${node.stage}`);

async function resolveProject(reference: string): Promise<string> {
  const projects = await send<ProjectRow[]>("GET", apiPaths.projects);
  const matches = projects.filter((p) => p.id === reference || p.name === reference);
  const [project] = matches;
  if (project === undefined) throw new CliFailure(`No project "${reference}"`);
  if (matches.length > 1) throw new CliFailure(`Several projects are called "${reference}". Use its ID`);
  return project.id;
}

/** Where a new node goes: as named, or else the parent's project, or else this session's. */
async function projectForNewNode(reference: string | undefined, parent: string | undefined): Promise<string> {
  if (reference !== undefined) return resolveProject(reference);
  const nearby = parent ?? process.env["AOP_NODE_ID"];
  if (nearby) return (await send<NodeView>("GET", apiPaths.node(nearby))).project_id;
  throw new CliFailure("Say which project with --project, or --parent, or run this in a session on a node.");
}

async function nodeCommand(argv: string[]): Promise<void> {
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
    const project = await projectForNewNode(values.project, values.parent);
    const node = await send<NodeView>("POST", apiPaths.projectAction(project, "nodes"), {
      title: values.title,
      actor: ACTOR,
      ...(values.body !== undefined ? { body: values.body } : {}),
      ...(values.parent !== undefined ? { parent_id: values.parent } : {}),
      ...(values.type !== undefined ? { type: values.type } : {}),
      ...(values.stage !== undefined ? { stage: values.stage } : {}),
    } satisfies CreateNodeRequest);
    console.log(`Created ${node.id} at ${node.stage}`);
    return;
  }
  if (action === "edit") {
    const usage = COMMANDS["node edit"];
    const { values, positionals } = args(rest, usage, { title: { type: "string" }, body: { type: "string" } });
    if (positionals.length > 1 || (values.title === undefined && values.body === undefined)) {
      throw usageError(usage);
    }
    const id = positionals[0] ?? ownNode();
    await send("PATCH", apiPaths.node(id), {
      actor: ACTOR,
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.body !== undefined ? { body: values.body } : {}),
    } satisfies EditNodeRequest);
    console.log(`Edited ${id}`);
    return;
  }
  throw usageError([...COMMANDS["node create"], ...COMMANDS["node edit"]]);
}

async function edgeCommand(argv: string[]): Promise<void> {
  const usage = COMMANDS.edge;
  const [action, kind, from, to, ...extra] = args(argv, usage, {}).positionals;
  if (kind !== "blocks" || from === undefined || to === undefined || extra.length > 0) throw usageError(usage);
  if (action === "add") {
    await send("POST", apiPaths.nodeAction(from, "edges"), { target_id: to, kind, actor: ACTOR } satisfies EdgeRequest);
    console.log(`${from} now blocks ${to}`);
    return;
  }
  if (action === "remove") {
    const edges = await send<EdgeRow[]>("GET", apiPaths.nodeAction(from, "edges"));
    const edge = edges.find((e) => e.kind === kind && e.source_id === from && e.target_id === to);
    if (!edge) throw new CliFailure(`${from} doesn't block ${to}`);
    await send("DELETE", apiPaths.edge(edge.id), { actor: ACTOR } satisfies ActorRequest);
    console.log(`${from} no longer blocks ${to}`);
    return;
  }
  throw usageError(usage);
}

async function searchCommand(argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, COMMANDS.search, { all: { type: "boolean" } });
  if (positionals.length === 0) throw usageError(COMMANDS.search);
  const query = new URLSearchParams({ q: positionals.join(" ") });
  const own = process.env["AOP_NODE_ID"];
  // With no node there's no current project to narrow to.
  if (values.all !== true && own) query.set("project", (await send<NodeView>("GET", apiPaths.node(own))).project_id);
  const results = await send<SearchResult[]>("GET", `${apiPaths.search}?${query}`);
  if (results.length === 0) console.log("No matches.");
  for (const result of results) {
    console.log(`${result.node_id}  [${result.stage}]  ${result.title}`);
    console.log(`    ${result.snippet.replace(/\s+/g, " ")}`);
  }
}

async function steerCommand(argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, COMMANDS.steer, { "no-sandbox": { type: "boolean" } });
  const id = only(positionals, COMMANDS.steer);
  const session = await send<SteerSession>("POST", apiPaths.nodeAction(id, "steer"), { no_sandbox: values["no-sandbox"] === true } satisfies SteerRequest);
  console.log(`Claimed ${id}. Opening a session in ${session.cwd}. Release the claim in the UI or with \`aop release ${id}\` when you're done.`);
  // The command is the user's own config string, which may need a shell. No node text goes in it.
  const child = spawn(session.command, {
    shell: true,
    cwd: session.cwd,
    stdio: "inherit",
    env: { ...process.env, AOP_NODE_ID: id, AOP_URL: serverUrl() },
  });
  await new Promise<void>((done, fail) => {
    child.once("error", (error) => fail(new CliFailure(`Couldn't open the session: ${error.message}`)));
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
      done();
    });
  });
}

/** Stops the agent running on a node, as the UI's Stop run does. The node stays put, claimed by the human. */
async function stopCommand(argv: string[]): Promise<void> {
  const id = only(args(argv, COMMANDS.stop, {}).positionals, COMMANDS.stop);
  const node = await send<NodeView>("GET", apiPaths.node(id));
  if (node.run_id === null) throw new CliFailure(`No agent is running on ${id}`);
  const stopped = await send<NodeView>("POST", apiPaths.run(node.run_id, "stop"));
  console.log(`Stopped ${node.run_id}. ${id} stays at ${stopped.stage}, claimed by you. Run \`aop release ${id}\` to start the stage again.`);
}

async function releaseCommand(argv: string[]): Promise<void> {
  const id = only(args(argv, COMMANDS.release, {}).positionals, COMMANDS.release);
  await send<NodeView>("POST", apiPaths.nodeAction(id, "release"), { actor: HUMAN } satisfies ActorRequest);
  console.log(`Released ${id}`);
}

/**
 * Prints the end of the node's latest run's log, as the node page shows it: the agent's readable
 * output, which for stream-json means its text rather than the raw events.
 */
async function logsCommand(argv: string[]): Promise<void> {
  const usage = COMMANDS.logs;
  const { values, positionals } = args(argv, usage, { lines: { type: "string" } });
  const id = only(positionals, usage);
  const lines = values.lines === undefined ? DEFAULT_LOG_LINES : Number(values.lines);
  if (!Number.isInteger(lines) || lines < 1) throw usageError(usage, "--lines must be a whole number above 0");
  const node = await send<NodeView>("GET", apiPaths.node(id));
  if (node.last_run_id === null) throw new CliFailure(`${id} has had no runs yet`);
  const tail = await send<LogTail>("GET", `${apiPaths.run(node.last_run_id, "tail")}?lines=${lines}`);
  if (tail.lines.length === 0) {
    console.log(`The log for ${node.last_run_id} is empty so far.`);
    return;
  }
  console.log(tail.lines.join("\n"));
}

function printAgents(agents: AgentProcessView[]): void {
  if (agents.length === 0) {
    console.log("No agents running.");
    return;
  }
  for (const agent of agents) {
    const identity = agent.identity === "confirmed" ? "" : "  (unverified)";
    const where = agent.node_title === null ? "(node deleted)" : `[${agent.stage}] ${agent.node_title}`;
    console.log(`${agent.run_id}  pid ${agent.pid}  ${agent.status}${identity}  node ${agent.node_id}  ${where}`);
  }
}

function printReaped(result: ReapResult): void {
  if (result.killed.length === 0) console.log("Nothing to reap.");
  for (const { run_id, pid, reason } of result.killed) console.log(`Killed ${run_id} (pid ${pid}): ${reason}`);
  for (const { run_id, pid, reason } of result.skipped) console.log(`Left alone ${run_id} (pid ${pid}): ${reason}`);
}

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "context": {
      const { positionals } = args(rest, COMMANDS.context, {});
      if (positionals.length > 1) throw usageError(COMMANDS.context);
      console.log(await sendForText(apiPaths.nodeAction(positionals[0] ?? ownNode(), "context")));
      return;
    }
    case "next": {
      const outcome = only(args(rest, COMMANDS.next, {}).positionals, COMMANDS.next);
      movedTo(await send("POST", apiPaths.nodeAction(ownNode(), "next"), { outcome, actor: ACTOR } satisfies NextRequest));
      return;
    }
    case "ask": {
      const question = only(args(rest, COMMANDS.ask, {}).positionals, COMMANDS.ask);
      movedTo(await send("POST", apiPaths.nodeAction(ownNode(), "ask"), { question } satisfies AskRequest));
      return;
    }
    case "fail": {
      const reason = only(args(rest, COMMANDS.fail, {}).positionals, COMMANDS.fail);
      movedTo(await send("POST", apiPaths.nodeAction(ownNode(), "fail"), { reason, actor: ACTOR } satisfies FailRequest));
      return;
    }
    case "message": {
      const { values, positionals } = args(rest, COMMANDS.message, { node: { type: "string" } });
      const body = only(positionals, COMMANDS.message);
      const message = await send<MessageRow>("POST", apiPaths.nodeAction(values.node ?? ownNode(), "messages"), { body, author: ACTOR } satisfies MessageRequest);
      console.log(`Posted to ${message.node_id}`);
      return;
    }
    case "link": {
      const [kind, url, ...extra] = args(rest, COMMANDS.link, {}).positionals;
      if ((kind !== "pr" && kind !== "ticket") || url === undefined || extra.length > 0) throw usageError(COMMANDS.link);
      await send("POST", apiPaths.nodeAction(ownNode(), "links"), { kind, url, actor: ACTOR } satisfies LinkRequest);
      console.log(`Linked ${kind} ${url}`);
      return;
    }
    case "search":
      return searchCommand(rest);
    case "node":
      return nodeCommand(rest);
    case "edge":
      return edgeCommand(rest);
    case "split": {
      const action = only(args(rest, COMMANDS.split, {}).positionals, COMMANDS.split);
      if (action !== "start" && action !== "finish") throw usageError(COMMANDS.split);
      movedTo(await send("POST", apiPaths.nodeAction(ownNode(), `split/${action}`)));
      return;
    }
    case "project": {
      const [action, path, ...extra] = args(rest, COMMANDS.project, {}).positionals;
      if (action !== "add" || path === undefined || extra.length > 0) throw usageError(COMMANDS.project);
      const project = await send<ProjectRow>("POST", apiPaths.projects, { repo_path: path } satisfies AddProjectRequest);
      console.log(`Added project "${project.name}" (${project.id})`);
      return;
    }
    case "serve": {
      // Loaded here because every other command only talks HTTP, and shouldn't need the database's native module.
      const { runServer } = await import("../server/serve.js");
      return runServer(rest, usageError(COMMANDS.serve).message);
    }
    case "steer":
      return steerCommand(rest);
    case "stop":
      return stopCommand(rest);
    case "release":
      return releaseCommand(rest);
    case "logs":
      return logsCommand(rest);
    case "ps":
      none(rest, COMMANDS.ps);
      printAgents(await send<AgentProcessView[]>("GET", apiPaths.agents));
      return;
    case "reap":
      none(rest, COMMANDS.reap);
      printReaped(await send<ReapResult>("POST", apiPaths.reap));
      return;
    case "init": {
      const { runInit } = await import("./init.js");
      process.exitCode = await runInit(rest, { usage: usageError(COMMANDS.init).message });
      return;
    }
    default:
      throw new UsageError(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
  } else if (error instanceof CliFailure) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
