import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../../server/config.js";
import { ConfigError } from "../../../server/errors.js";
import { aopHome, configPath } from "../../../server/paths.js";
import { MCP_PORT } from "../../../shared/http/mcpPort.js";
import { configText } from "./configText.js";
import { configSetting, copyDefaults, usesHomeFile } from "./defaultFiles.js";
import { expandPath, gatherSettings, InitFailure, lineReader, type Values } from "./settings.js";

/** What `aop init --help` adds under the CLI's usage line. */
const FLAG_HELP = `Sets up AOP_HOME, or ~/.aop. Asks for each setting, unless a flag gives it.
  --yes                Don't ask. Settings not given by flags use their defaults.
  --fill-missing       Config exists: only add missing default files. Never overwrites.
  --if-new             Config exists: say so and change nothing, without failing.
  --stages <file>      Use your own stages file instead of the default setup.
  --create-open-from   Create the open_from folder if it doesn't exist.
  --improvements-path <dir>
                       The folder improvements may change. Default: ~/.aop/skills.`;

/** What `aop init` reads and writes, so tests can run it with a fake terminal, PATH and home. */
export interface InitIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Where failures go. */
  errors: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  /** The installed package, holding `defaults/`. */
  packageRoot: string;
  /** The usage line from the CLI's command table, for help and usage errors. */
  usage: string;
}

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../../..");

const TOOLS = ["claude", "copilot"] as const;
type Tool = (typeof TOOLS)[number];

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

/** The git repo holding `path`, if any. AOP's state must stay out of repos. */
function repoAround(path: string): string | undefined {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}



/** Creates the improvements folder, unless that would write into a git repo, which is the user's to do. */
function ensureImprovementsFolder(path: string, say: (text: string) => void): void {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) throw new InitFailure(`improvements_path ${path} isn't a folder.`);
    return;
  }
  const repo = repoAround(path);
  if (repo !== undefined) {
    throw new InitFailure(`improvements_path ${path} doesn't exist, and it's inside the git repo ${repo}, so AOP won't create it. Create it first.`);
  }
  mkdirSync(path, { recursive: true });
  say(`Created ${path}`);
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
        "if-new": { type: "boolean" },
        "agent-session-command": { type: "string" },
        "out-of-sandbox-command": { type: "string" },
        "open-from": { type: "string" },
        "create-open-from": { type: "boolean" },
        "agent-timeout-minutes": { type: "string" },
        stages: { type: "string" },
        "improvements-path": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
    if (values.help === true) {
      io.output.write(`${io.usage}\n\n${FLAG_HELP}\n`);
      return;
    }
  } catch (error) {
    throw new UsageFailure(`${error instanceof Error ? error.message : String(error)}\n${io.usage}`);
  }

  const say = (text: string) => {
    io.output.write(`${text}\n`);
  };
  const home = aopHome(io.env, io.cwd);
  const repo = repoAround(home);
  if (repo !== undefined) {
    throw new InitFailure(`${home} is inside the git repo ${repo}. AOP keeps its own files out of git repos. Set AOP_HOME to a folder outside it.`);
  }
  const configFile = configPath(home);
  const configExists = existsSync(configFile);
  if (configExists && values["if-new"] === true) {
    say(`AOP is already set up in ${home}. Edit ${configFile} to change it.`);
    return;
  }
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
    const noImprovements = configSetting(home, "improvement_stages") === undefined;
    copyDefaults(io.packageRoot, home, say, {
      work: usesHomeFile(home, "stages", "stages.yaml"),
      improvements: noImprovements || usesHomeFile(home, "improvement_stages", "improvement_stages.yaml"),
    });
    if (configSetting(home, "improvements_path") === undefined) ensureImprovementsFolder(join(home, "skills"), say);
    if (noImprovements) {
      say(`Improvements are off. To turn them on, add this line to ${configFile}:\n  improvement_stages: ./improvement_stages.yaml`);
    }
  } else {
    const reader = values.yes === true ? undefined : lineReader(io.input, io.output);
    let gathered: Awaited<ReturnType<typeof gatherSettings>>;
    try {
      gathered = await gatherSettings({ values, ask: reader?.ask, tool: [...found.keys()][0], cwd: io.cwd, say });
    } finally {
      reader?.close();
    }
    const { settings, createOpenFrom } = gathered;
    say("");
    // First, because it's the one step here that can refuse, and nothing has been written yet.
    ensureImprovementsFolder(expandPath(settings.improvements_path, home), say);
    if (createOpenFrom !== undefined) {
      mkdirSync(createOpenFrom, { recursive: true });
      say(`Created ${createOpenFrom}`);
    }
    mkdirSync(home, { recursive: true });
    copyDefaults(io.packageRoot, home, say, { work: settings.stages === "./stages.yaml", improvements: true });
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

  if (!config.agent_session_command.includes("--permission-mode")) {
    say(
      "\nAgents run headless, so they can't ask you to approve commands or edits. Consider Claude Code's auto mode: add `--permission-mode auto` to agent_session_command, or set permissions.defaultMode to \"auto\" in ~/.claude/settings.json.",
    );
  }
  say(`\nAgents need AOP's MCP server. For Claude Code: claude mcp add --scope user --transport http aop http://127.0.0.1:${MCP_PORT}/mcp`);
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
    usage: "Usage: aop init [options]",
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
