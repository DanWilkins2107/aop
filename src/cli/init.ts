import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { loadConfig } from "../server/config.js";
import { ConfigError } from "../server/errors.js";
import { loadStagesFile } from "../server/stages.js";
import { parseYamlFile } from "../server/yamlFile.js";

export const INIT_USAGE = `Usage: aop init [--yes] [--fill-missing] [--agent-session-command <cmd>] [--out-of-sandbox-command <cmd>]
                [--open-from <dir>] [--create-open-from] [--agent-timeout-minutes <n>] [--stages <file>]

Sets up AOP_HOME, or ~/.aop. Asks for each setting, unless a flag gives it.
  --yes                Don't ask. Settings not given by flags use their defaults.
  --fill-missing       Config exists: only add missing default files. Never overwrites.
  --stages <file>      Use your own stages file instead of the default process.
  --create-open-from   Create the open_from folder if it doesn't exist.`;

/** What `aop init` reads and writes, so tests can run it with a fake terminal, PATH and home. */
export interface InitIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Where failures go. */
  errors: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  /** The installed package, holding `defaults/` and `plugin/`. */
  packageRoot: string;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ABOUT = {
  agent_session_command:
    "This is the session your agents are starting in. Strongly consider having this command start sessions inside a sandbox.",
  out_of_sandbox_command:
    "Sometimes you may need to run and supervise a session that runs outside of a sandbox (using `aop steer --no-sandbox`). Not needed if you're not running sessions sandboxed.",
  open_from: "Where sessions start for projects with no path.",
  agent_timeout_minutes: "How long an agent can run before it's stopped and its node goes to `failed`.",
  stages: "The file that defines your process.",
};

const TOOLS = ["claude", "copilot"] as const;
type Tool = (typeof TOOLS)[number];

class InitFailure extends Error {}
class UsageFailure extends Error {}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Finds a command on PATH by looking at files only. It never runs anything. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const dirs = (envValue(env, "PATH") ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names =
    platform === "win32"
      ? (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => name + ext.toLowerCase())
      : [name];
  for (const dir of dirs) {
    for (const candidate of names.map((n) => join(dir, n))) {
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

function aopHomeFor(io: InitIo): string {
  const fromEnv = io.env["AOP_HOME"];
  return fromEnv ? resolve(io.cwd, fromEnv) : join(homedir(), ".aop");
}

/** `~` and `~/x` are the user's home; anything else relative is from where `aop init` runs. */
function expandPath(path: string, cwd: string): string {
  const fromHome = /^~(?:[\\/](.*))?$/.exec(path);
  return fromHome ? resolve(join(homedir(), fromHome[1] ?? "")) : resolve(cwd, path);
}

/** The git repo holding `path`, if any. AOP's state must stay out of repos. */
function repoAround(path: string): string | undefined {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const yamlScalar = (value: string | number) => stringify(value, { lineWidth: 0 }).trimEnd();

/** Wraps lines for config comments. */
function comment(text: string): string {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > 90 && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  return [...lines, line].join("\n");
}

interface Settings {
  agent_session_command: string;
  out_of_sandbox_command: string | undefined;
  open_from: string;
  agent_timeout_minutes: number;
  /** As written in config.yaml. */
  stages: string;
}

export function configText(settings: Settings): string {
  const outOfSandbox =
    settings.out_of_sandbox_command === undefined
      ? "# out_of_sandbox_command: claude"
      : `out_of_sandbox_command: ${yamlScalar(settings.out_of_sandbox_command)}`;
  return `# AOP machine config, shared by all projects. Written by \`aop init\`.
# Relative paths start from this file's folder. \`~\` is your home folder.

# Required. AOP appends \`-p\` and sends the prompt on stdin.
${comment(ABOUT.agent_session_command)}
agent_session_command: ${yamlScalar(settings.agent_session_command)}

# Optional.
${comment(ABOUT.out_of_sandbox_command)}
${outOfSandbox}

${comment(ABOUT.open_from)}
open_from: ${yamlScalar(settings.open_from)}

${comment(ABOUT.agent_timeout_minutes)}
agent_timeout_minutes: ${settings.agent_timeout_minutes}

${comment(ABOUT.stages)} It can live anywhere.
stages: ${yamlScalar(settings.stages)}
`;
}

/** Reads answers line by line. Buffers lines that arrive early, so piped answers work too. */
function lineReader(io: InitIo) {
  const rl = createInterface({ input: io.input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question: string): Promise<string> {
      io.output.write(question);
      const next = await lines.next();
      if (next.done) throw new InitFailure("\nInput ended before setup finished. Nothing was written.");
      return next.value.trim();
    },
    close: () => rl.close(),
  };
}

type Ask = (question: string) => Promise<string>;

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

type Values = {
  yes?: boolean;
  "fill-missing"?: boolean;
  "agent-session-command"?: string;
  "out-of-sandbox-command"?: string;
  "open-from"?: string;
  "create-open-from"?: boolean;
  "agent-timeout-minutes"?: string;
  stages?: string;
};

/** Gets every setting, from flags first, then by asking, or from defaults with --yes. */
async function gatherSettings(io: InitIo, values: Values, ask: Ask | undefined, found: Map<Tool, string>): Promise<Settings> {
  const say = (text: string) => io.output.write(`${text}\n`);
  const suggested = [...found.keys()][0];

  // agent_session_command
  let sessionCommand = values["agent-session-command"]?.trim();
  if (sessionCommand === "") throw new InitFailure("--agent-session-command can't be empty.");
  if (sessionCommand === undefined) {
    if (!ask) throw new InitFailure("--agent-session-command is required with --yes.");
    say(`\nAgent session command (required). ${ABOUT.agent_session_command}`);
    while (sessionCommand === undefined) {
      const answer = await ask(suggested ? `Command [${suggested}]: ` : "Command: ");
      sessionCommand = answer || suggested;
      if (sessionCommand === undefined) say("This one is required.");
    }
  }

  // out_of_sandbox_command
  let outOfSandbox = values["out-of-sandbox-command"]?.trim() || undefined;
  if (values["out-of-sandbox-command"] === undefined && ask) {
    say(`\nOut of sandbox command (optional). ${ABOUT.out_of_sandbox_command}`);
    outOfSandbox = (await ask(suggested ? `Command, or blank to skip (e.g. ${suggested}): ` : "Command, or blank to skip: ")) || undefined;
  }

  // open_from
  const openFromFlag = values["open-from"]?.trim();
  if (openFromFlag === "") throw new InitFailure("--open-from can't be empty.");
  let openFrom: string;
  if (openFromFlag !== undefined || !ask) {
    openFrom = openFromFlag ?? "~/code";
    const path = expandPath(openFrom, io.cwd);
    let problem = openFromProblem(path);
    if (problem === "doesn't exist" && values["create-open-from"] === true) {
      mkdirSync(path, { recursive: true });
      say(`Created ${path}`);
      problem = undefined;
    }
    if (problem !== undefined) {
      const hint = problem === "doesn't exist" ? " Create it, pass --create-open-from, or pick another with --open-from." : "";
      throw new InitFailure(`open_from ${path} ${problem}.${hint}`);
    }
  } else {
    say(`
Open from. ${ABOUT.open_from}`);
    for (;;) {
      openFrom = (await ask("Folder [~/code]: ")) || "~/code";
      const path = expandPath(openFrom, io.cwd);
      const problem = openFromProblem(path);
      if (problem === undefined) break;
      if (problem !== "doesn't exist") {
        say(`${path} ${problem}.`);
        continue;
      }
      if (values["create-open-from"] === true || /^y(es)?$/i.test(await ask(`${path} doesn't exist. Create it? [y/N]: `))) {
        mkdirSync(path, { recursive: true });
        say(`Created ${path}`);
        break;
      }
    }
  }
  // Keep `~` forms as typed. Other paths are stored absolute, since config paths are relative to AOP_HOME.
  const openFromSetting = /^~(?:[\\/]|$)/.test(openFrom) ? openFrom : expandPath(openFrom, io.cwd);

  // agent_timeout_minutes
  let timeout: number | undefined;
  const timeoutFlag = values["agent-timeout-minutes"];
  if (timeoutFlag !== undefined) {
    timeout = parseTimeout(timeoutFlag.trim());
    if (timeout === undefined) throw new InitFailure("--agent-timeout-minutes must be a positive number.");
  } else if (ask) {
    say(`\nAgent timeout. ${ABOUT.agent_timeout_minutes}`);
    while (timeout === undefined) {
      const answer = await ask("Minutes [60]: ");
      timeout = answer === "" ? 60 : parseTimeout(answer);
      if (timeout === undefined) say("Enter a positive number of minutes.");
    }
  } else {
    timeout = 60;
  }

  // stages: the default process, or the user's own file
  let stages = "./stages.yaml";
  let ownStages = values.stages?.trim() || undefined;
  if (values.stages === undefined && ask) {
    say(`\nProcess. The default: an agent triages each task and may split it, then an agent implements it and raises a PR for your review.`);
    const useDefault = !/^n(o)?$/i.test(await ask("Use the default process? [Y/n]: "));
    while (!useDefault && ownStages === undefined) {
      const answer = await ask("Path to your stages.yaml: ");
      if (answer === "") continue;
      const problems = stagesProblems(expandPath(answer, io.cwd));
      if (problems.length === 0) ownStages = answer;
      else for (const p of problems) say(`  ${p}`);
    }
  }
  if (ownStages !== undefined) {
    const path = expandPath(ownStages, io.cwd);
    const problems = stagesProblems(path);
    if (problems.length > 0) throw new InitFailure(`The stages file has problems:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    stages = path;
  }

  return {
    agent_session_command: sessionCommand,
    out_of_sandbox_command: outOfSandbox,
    open_from: openFromSetting,
    agent_timeout_minutes: timeout,
    stages,
  };
}

/** Copies the default process into `home`, skipping any file already there. */
function copyDefaults(io: InitIo, home: string, say: (text: string) => void): void {
  const defaults = join(io.packageRoot, "defaults");
  const files = ["stages.yaml", ...readdirSync(join(defaults, "prompts")).map((name) => join("prompts", name))];
  mkdirSync(join(home, "prompts"), { recursive: true });
  for (const file of files) {
    const target = join(home, file);
    if (existsSync(target)) {
      say(`Kept ${target}`);
      continue;
    }
    copyFileSync(join(defaults, file), target);
    say(`Wrote ${target}`);
  }
}

/** Whether the config at `home` uses `home/stages.yaml`, so the default process belongs there. */
function usesHomeStages(home: string): boolean {
  const parsed = parseYamlFile(join(home, "config.yaml"));
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return false;
  const stages = (parsed.value as Record<string, unknown>)["stages"];
  return typeof stages === "string" && resolve(home, stages) === join(home, "stages.yaml");
}

const quoted = (path: string) => (/\s/.test(path) ? `"${path}"` : path);

function pluginSteps(io: InitIo, found: Map<Tool, string>): string {
  const plugin = join(io.packageRoot, "plugin");
  const steps: Record<Tool, string> = {
    claude: `Claude Code, inside a claude session:\n  /plugin marketplace add ${plugin}\n  /plugin install aop@aop\nOr for one session: claude --plugin-dir ${quoted(plugin)}`,
    copilot: `GitHub Copilot CLI (untested):\n  copilot plugin install ${quoted(plugin)}`,
  };
  const tools = found.size > 0 ? [...found.keys()] : [...TOOLS];
  const intro = found.size > 0 ? "Install the AOP plugin, which teaches agents how to work on AOP stages:" : "Didn't find claude or copilot on PATH. To install the AOP plugin later:";
  return [intro, ...tools.map((tool) => steps[tool])].join("\n\n");
}

async function init(argv: string[], io: InitIo): Promise<void> {
  let values: Values;
  try {
    values = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        yes: { type: "boolean", short: "y" },
        "fill-missing": { type: "boolean" },
        "agent-session-command": { type: "string" },
        "out-of-sandbox-command": { type: "string" },
        "open-from": { type: "string" },
        "create-open-from": { type: "boolean" },
        "agent-timeout-minutes": { type: "string" },
        stages: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
    if ((values as { help?: boolean }).help) {
      io.output.write(`${INIT_USAGE}\n`);
      return;
    }
  } catch (error) {
    throw new UsageFailure(`${(error as Error).message}\n\n${INIT_USAGE}`);
  }

  const say = (text: string) => io.output.write(`${text}\n`);
  const home = aopHomeFor(io);
  const repo = repoAround(home);
  if (repo !== undefined) {
    throw new InitFailure(`${home} is inside the git repo ${repo}. AOP never writes to repos. Set AOP_HOME to a folder outside it.`);
  }
  const configFile = join(home, "config.yaml");
  const configExists = existsSync(configFile);
  if (configExists && values["fill-missing"] !== true) {
    throw new InitFailure(
      `${configFile} already exists, so nothing was changed. Edit it by hand, or run \`aop init --fill-missing\` to add only missing files.`,
    );
  }

  const found = new Map<Tool, string>();
  for (const tool of TOOLS) {
    const path = findOnPath(tool, io.env, io.platform);
    if (path !== undefined) found.set(tool, path);
  }

  say(`Setting up AOP in ${home}`);
  if (found.size > 0) for (const [tool, path] of found) say(`Found ${tool}: ${path}`);
  else say("Didn't find claude or copilot on PATH.");

  if (configExists) {
    say(`Keeping ${configFile}. Only adding missing files.`);
    if (usesHomeStages(home)) copyDefaults(io, home, say);
  } else {
    const reader = values.yes === true ? undefined : lineReader(io);
    let settings: Settings;
    try {
      settings = await gatherSettings(io, values, reader?.ask, found);
    } finally {
      reader?.close();
    }
    say("");
    mkdirSync(home, { recursive: true });
    if (settings.stages === "./stages.yaml") copyDefaults(io, home, say);
    writeFileSync(configFile, configText(settings), { flag: "wx" });
    say(`Wrote ${configFile}`);
  }

  let config;
  try {
    config = loadConfig(home);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new InitFailure(`\nThe config has problems. Fix them in ${configFile}:\n${error.problems.map((p) => `  ${p}`).join("\n")}`);
  }
  say("\nThe config is valid.");
  if (!existsSync(config.openFromPath)) say(`Note: open_from ${config.openFromPath} doesn't exist yet.`);

  say(`\n${pluginSteps(io, found)}`);
  if (findOnPath("aop", io.env, io.platform) === undefined) {
    say("\nAgents also need `aop` on PATH. Run `npm link` in the AOP package, or install it globally.");
  }
  say("\nNext:\n  aop serve\n  Then add a project in the UI, or with: aop project add <path>");
}


/** Runs `aop init`. Returns the exit code: 0 done, 1 stopped, 2 bad usage. */
export async function runInit(argv: string[], partial: Partial<InitIo> = {}): Promise<number> {
  const io: InitIo = {
    input: process.stdin,
    output: process.stdout,
    errors: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    packageRoot: PACKAGE_ROOT,
    ...partial,
  };
  try {
    await init(argv, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageFailure) {
      io.errors.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof InitFailure) {
      io.errors.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
