#!/usr/bin/env node
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

/** Each command's usage, for both the help and its own usage errors, so the two can't drift apart. */
const AGENT_COMMANDS = {
  context: ["aop context [<id>]"],
  next: ["aop next <outcome>"],
  ask: ['aop ask "..."'],
  message: ['aop message "..." [--node <id>]'],
  link: ["aop link pr|ticket <url>"],
  search: ["aop search <query> [--all]"],
  "node create": ["aop node create --title ... [--body ...] [--parent ...] [--project ...] [--type ... | --stage ...]"],
  "node edit": ["aop node edit [<id>] [--title ...] [--body ...]"],
  edge: ["aop edge add blocks <from> <to>", "aop edge remove blocks <from> <to>"],
  split: ["aop split start", "aop split finish"],
} as const;
const HUMAN_COMMANDS = {
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

const serverUrl = () => process.env["AOP_URL"] ?? `http://127.0.0.1:${process.env["AOP_PORT"] ?? DEFAULT_PORT}`;

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${serverUrl()}/api${path}`, init);
  } catch {
    throw new CliFailure(`Can't reach the AOP server at ${serverUrl()}. Is \`aop serve\` running?`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `The server answered ${response.status}`;
    try {
      const { error } = JSON.parse(text) as { error: { message: string; details?: unknown } };
      message = error.message;
      if (error.details !== undefined) message += `\n${JSON.stringify(error.details)}`;
    } catch {
      // Not one of the API's own errors, so the status is all there is.
    }
    throw new CliFailure(message);
  }
  return (response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
}

const nodePath = (id: string) => `/nodes/${encodeURIComponent(id)}`;

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
  const projects = await send<ProjectRow[]>("GET", "/projects");
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
  if (nearby) return (await send<NodeView>("GET", nodePath(nearby))).project_id;
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
    const node = await send<NodeView>("POST", `/projects/${encodeURIComponent(project)}/nodes`, {
      title: values.title,
      actor: ACTOR,
      ...(values.body !== undefined ? { body: values.body } : {}),
      ...(values.parent !== undefined ? { parent_id: values.parent } : {}),
      ...(values.type !== undefined ? { type: values.type } : {}),
      ...(values.stage !== undefined ? { stage: values.stage } : {}),
    });
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
    await send("PATCH", nodePath(id), {
      actor: ACTOR,
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.body !== undefined ? { body: values.body } : {}),
    });
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
    await send("POST", `${nodePath(from)}/edges`, { target_id: to, kind, actor: ACTOR });
    console.log(`${from} now blocks ${to}`);
    return;
  }
  if (action === "remove") {
    const edges = await send<EdgeRow[]>("GET", `${nodePath(from)}/edges`);
    const edge = edges.find((e) => e.kind === kind && e.source_id === from && e.target_id === to);
    if (!edge) throw new CliFailure(`${from} doesn't block ${to}`);
    await send("DELETE", `/edges/${encodeURIComponent(edge.id)}`, { actor: ACTOR });
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
  if (values.all !== true && own) query.set("project", (await send<NodeView>("GET", nodePath(own))).project_id);
  const results = await send<SearchResult[]>("GET", `/search?${query}`);
  if (results.length === 0) console.log("No matches.");
  for (const result of results) {
    console.log(`${result.node_id}  [${result.stage}]  ${result.title}`);
    console.log(`    ${result.snippet.replace(/\s+/g, " ")}`);
  }
}

async function steerCommand(argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, COMMANDS.steer, { "no-sandbox": { type: "boolean" } });
  const id = only(positionals, COMMANDS.steer);
  const session = await send<SteerSession>("POST", `${nodePath(id)}/steer`, { no_sandbox: values["no-sandbox"] === true });
  console.log(`Claimed ${id}. Opening a session in ${session.cwd}. Release the claim in the UI when you're done.`);
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
      console.log(await send<string>("GET", `${nodePath(positionals[0] ?? ownNode())}/context`));
      return;
    }
    case "next": {
      const outcome = only(args(rest, COMMANDS.next, {}).positionals, COMMANDS.next);
      movedTo(await send("POST", `${nodePath(ownNode())}/next`, { outcome, actor: ACTOR }));
      return;
    }
    case "ask": {
      const question = only(args(rest, COMMANDS.ask, {}).positionals, COMMANDS.ask);
      movedTo(await send("POST", `${nodePath(ownNode())}/ask`, { question }));
      return;
    }
    case "message": {
      const { values, positionals } = args(rest, COMMANDS.message, { node: { type: "string" } });
      const body = only(positionals, COMMANDS.message);
      const message = await send<MessageRow>("POST", `${nodePath(values.node ?? ownNode())}/messages`, { body, author: ACTOR });
      console.log(`Posted to ${message.node_id}`);
      return;
    }
    case "link": {
      const [kind, url, ...extra] = args(rest, COMMANDS.link, {}).positionals;
      if ((kind !== "pr" && kind !== "ticket") || url === undefined || extra.length > 0) throw usageError(COMMANDS.link);
      await send("POST", `${nodePath(ownNode())}/links`, { kind, url, actor: ACTOR });
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
      movedTo(await send("POST", `${nodePath(ownNode())}/split/${action}`));
      return;
    }
    case "project": {
      const [action, path, ...extra] = args(rest, COMMANDS.project, {}).positionals;
      if (action !== "add" || path === undefined || extra.length > 0) throw usageError(COMMANDS.project);
      const project = await send<ProjectRow>("POST", "/projects", { repo_path: path });
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
    case "ps":
      none(rest, COMMANDS.ps);
      printAgents(await send<AgentProcessView[]>("GET", "/agents"));
      return;
    case "reap":
      none(rest, COMMANDS.reap);
      printReaped(await send<ReapResult>("POST", "/agents/reap"));
      return;
    case "init":
      throw new CliFailure("aop init isn't available yet. Create config.yaml in AOP_HOME or ~/.aop by hand for now.");
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
