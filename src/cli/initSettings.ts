import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isFromUserHome, resolveConfigPath } from "../server/paths.js";
import { loadStagesFile } from "../server/stages.js";
import { MCP_PORT } from "../shared/http/mcpPort.js";

/** `aop init` stopped, with a message for the user. */
export class InitFailure extends Error {}

/** What each setting is for, both when asking for it and in the written config. */
export const ABOUT = {
  agent_session_command:
    `This is the session your agents are starting in. It must have AOP's MCP server (http://127.0.0.1:${MCP_PORT}/mcp) configured. Strongly consider having this command start sessions inside a sandbox. The sandbox must allow 127.0.0.1:${MCP_PORT}.`,
  out_of_sandbox_command:
    "Sometimes you may need to run and supervise a session that runs outside of a sandbox (using `aop steer --no-sandbox`). Not needed if you're not running sessions sandboxed.",
  open_from: "Where sessions start for projects with no path.",
  agent_timeout_minutes: "How long an agent can run before it's stopped and its node goes to `failed`.",
  stages: "The file that defines your process.",
  improvement_stages: "The pipeline that drafts, reviews and applies improvements to your skills and stage prompts.",
  improvements_path:
    "The folder improvements may change, along with your stage prompts. Raise PR is offered only when it's inside a git repo.",
};

export interface Settings {
  agent_session_command: string;
  out_of_sandbox_command: string | undefined;
  open_from: string;
  agent_timeout_minutes: number;
  /** As written in config.yaml. */
  stages: string;
  /** As written in config.yaml. */
  improvements_path: string;
}

/** The parsed `aop init` flags. */
export type Values = {
  yes?: boolean;
  "fill-missing"?: boolean;
  "if-new"?: boolean;
  "agent-session-command"?: string;
  "out-of-sandbox-command"?: string;
  "open-from"?: string;
  "create-open-from"?: boolean;
  "agent-timeout-minutes"?: string;
  stages?: string;
  "improvements-path"?: string;
};

export type Ask = (question: string) => Promise<string>;

/** Reads answers line by line. Buffers lines that arrive early, so piped answers work too. */
export function lineReader(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question: string): Promise<string> {
      output.write(question);
      const next = await lines.next();
      if (next.done) throw new InitFailure("\nInput ended before setup finished. Nothing was written.");
      return next.value.trim();
    },
    close: () => rl.close(),
  };
}

/** `~` and `~/x` are the user's home; anything else relative is from where `aop init` runs. */
export const expandPath = (path: string, cwd: string) => resolveConfigPath(cwd, path);

function parseTimeout(text: string): number | undefined {
  const value = Number(text);
  return text !== "" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function openFromProblem(path: string): string | undefined {
  if (!existsSync(path)) return "doesn't exist";
  if (!statSync(path).isDirectory()) return "isn't a folder";
  return undefined;
}

function stagesProblems(path: string): string[] {
  if (!existsSync(path)) return [`${path}: file not found`];
  return loadStagesFile(path).problems;
}

/** Where each setting comes from. `ask` is undefined with --yes. */
interface Sources {
  values: Values;
  ask: Ask | undefined;
  /** The first tool found on PATH, which picks the suggested commands. */
  tool: "claude" | "copilot" | undefined;
  cwd: string;
  say: (text: string) => void;
}

/** Offered as the agent session command, unless only copilot is installed. */
export const CLAUDE_AUTO_COMMAND = "claude --permission-mode auto";

async function sessionCommand({ values, ask, tool, say }: Sources): Promise<string> {
  const command = values["agent-session-command"]?.trim();
  if (command === "") throw new InitFailure("--agent-session-command can't be empty.");
  if (command !== undefined) return command;
  if (!ask) throw new InitFailure("--agent-session-command is required with --yes.");
  const suggested = tool === "copilot" ? "copilot" : CLAUDE_AUTO_COMMAND;
  say(`\nAgent session command (required). ${ABOUT.agent_session_command}`);
  say("Agents run headless, so they can't ask you to approve anything. Use Claude Code's auto mode, or an equivalent.");
  return (await ask(`Command [${suggested}]: `)) || suggested;
}

async function outOfSandboxCommand({ values, ask, tool: suggested, say }: Sources): Promise<string | undefined> {
  const flag = values["out-of-sandbox-command"];
  if (flag !== undefined || !ask) return flag?.trim() || undefined;
  say(`\nOut of sandbox command (optional). ${ABOUT.out_of_sandbox_command}`);
  return (await ask(suggested ? `Command, or blank to skip (e.g. ${suggested}): ` : "Command, or blank to skip: ")) || undefined;
}

/** The open_from setting, and the folder to create for it, if it doesn't exist yet. */
async function openFrom({ values, ask, cwd, say }: Sources): Promise<{ setting: string; create: string | undefined }> {
  const flag = values["open-from"]?.trim();
  if (flag === "") throw new InitFailure("--open-from can't be empty.");
  const createAllowed = values["create-open-from"] === true;
  let typed: string;
  let create: string | undefined;
  if (flag !== undefined || !ask) {
    typed = flag ?? "~/code";
    const path = expandPath(typed, cwd);
    const problem = openFromProblem(path);
    if (problem === "doesn't exist" && createAllowed) create = path;
    else if (problem !== undefined) {
      const hint = problem === "doesn't exist" ? " Create it, pass --create-open-from, or pick another with --open-from." : "";
      throw new InitFailure(`open_from ${path} ${problem}.${hint}`);
    }
  } else {
    say(`\nOpen from. ${ABOUT.open_from}`);
    for (;;) {
      typed = (await ask("Folder [~/code]: ")) || "~/code";
      const path = expandPath(typed, cwd);
      const problem = openFromProblem(path);
      if (problem === undefined) break;
      if (problem !== "doesn't exist") {
        say(`${path} ${problem}.`);
        continue;
      }
      if (createAllowed || /^y(es)?$/i.test(await ask(`${path} doesn't exist. Create it? [y/N]: `))) {
        create = path;
        break;
      }
    }
  }
  // Keep `~` forms as typed. Other paths are stored absolute, since config paths are relative to AOP_HOME.
  return { setting: isFromUserHome(typed) ? typed : expandPath(typed, cwd), create };
}

async function timeoutMinutes({ values, ask, say }: Sources): Promise<number> {
  const flag = values["agent-timeout-minutes"];
  if (flag !== undefined) {
    const timeout = parseTimeout(flag.trim());
    if (timeout === undefined) throw new InitFailure("--agent-timeout-minutes must be a positive number.");
    return timeout;
  }
  if (!ask) return 60;
  say(`\nAgent timeout. ${ABOUT.agent_timeout_minutes}`);
  for (;;) {
    const answer = await ask("Minutes [60]: ");
    const timeout = answer === "" ? 60 : parseTimeout(answer);
    if (timeout !== undefined) return timeout;
    say("Enter a positive number of minutes.");
  }
}

/** The default process, as `./stages.yaml`, or the absolute path of the user's own file. */
async function stagesSetting({ values, ask, cwd, say }: Sources): Promise<string> {
  let own = values.stages?.trim() || undefined;
  if (values.stages === undefined && ask) {
    say(`\nProcess. The default: an agent triages each task and may split it, then an agent implements it and raises a PR for your review.`);
    const useDefault = !/^n(o)?$/i.test(await ask("Start with the default setup? [Y/n]: "));
    while (!useDefault && own === undefined) {
      const answer = await ask("Path to your stages.yaml: ");
      if (answer === "") continue;
      const problems = stagesProblems(expandPath(answer, cwd));
      if (problems.length === 0) own = answer;
      else for (const p of problems) say(`  ${p}`);
    }
  }
  if (own === undefined) return "./stages.yaml";
  const path = expandPath(own, cwd);
  const problems = stagesProblems(path);
  if (problems.length > 0) throw new InitFailure(`The stages file has problems:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return path;
}

export const DEFAULT_IMPROVEMENTS_PATH = "./skills";

/** Stored as typed when it starts with `~`, and absolute otherwise, like open_from. The default sits in AOP_HOME. */
function improvementsSetting({ values, cwd }: Sources): string {
  const flag = values["improvements-path"]?.trim();
  if (flag === "") throw new InitFailure("--improvements-path can't be empty.");
  if (flag === undefined) return DEFAULT_IMPROVEMENTS_PATH;
  return isFromUserHome(flag) ? flag : expandPath(flag, cwd);
}

/**
 * Gets every setting, from flags first, then by asking, or from defaults with --yes. It only
 * reads: the open_from folder to create is returned, for the caller to make once nothing can stop it.
 */
export async function gatherSettings(sources: Sources): Promise<{ settings: Settings; createOpenFrom: string | undefined }> {
  const agent_session_command = await sessionCommand(sources);
  const out_of_sandbox_command = await outOfSandboxCommand(sources);
  const open_from = await openFrom(sources);
  const agent_timeout_minutes = await timeoutMinutes(sources);
  const stages = await stagesSetting(sources);
  const improvements_path = improvementsSetting(sources);
  return {
    settings: {
      agent_session_command,
      out_of_sandbox_command,
      open_from: open_from.setting,
      agent_timeout_minutes,
      stages,
      improvements_path,
    },
    createOpenFrom: open_from.create,
  };
}
