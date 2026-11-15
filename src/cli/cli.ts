// `aop`. It finds the command in `commands/registry.ts` and runs it. Every command is an HTTP call
// to the server, except `init` and `serve`, which runs the server in this process.
// `main.ts` runs it on the real process. Tests run it in-process through `runCli`, with their own environment and output.

import { readFileSync } from "node:fs";
import { DEFAULT_PORT } from "../shared/http/defaultPort.js";
import { MCP_PORT } from "../shared/http/mcpPort.js";
import { COMMANDS, HUMAN_COMMANDS } from "./commands/registry.js";
import type { CliIo, Command, Ctx } from "./shared/command.js";
import { CliFailure } from "./shared/cliFailure.js";
import { UsageError, usageError } from "./shared/errors.js";

const USAGE = `aop: agent orchestration platform

${Object.values(HUMAN_COMMANDS)
  .flat()
  .map((line) => `  ${line}`)
  .join("\n")}
  aop <command> --help
  aop --version

Agents use AOP's MCP server at http://127.0.0.1:${MCP_PORT}/mcp.

Finds the server through AOP_URL, or AOP_PORT on localhost, or else port ${DEFAULT_PORT}.`;

/** The package's version. `cli.ts` is two folders down from `package.json`, in `src/` and in `dist/` alike. */
function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  if (typeof pkg !== "object" || pkg === null || !("version" in pkg) || typeof pkg.version !== "string") throw new Error("package.json has no version");
  return pkg.version;
}

const isHelp = (arg: string) => arg === "--help" || arg === "-h";

/** Whether `argv` asks for help, before any `--` that ends the options. */
const asksHelp = (argv: string[]) => {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).some((arg) => isHelp(arg));
};

function find(name: string): Command {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) throw new UsageError(`Unknown command "${name}"\n\n${USAGE}`);
  return command;
}

/** A command's usage, as its usage errors show it, then its own help if it has any. */
const commandHelp = (command: Command) => [usageError(command.usage).message, ...(command.help === undefined ? [] : ["", command.help])].join("\n");

/** Runs a command, and gives its exit code when it isn't 0. */
async function run(c: Ctx, argv: string[]): Promise<number | void> {
  const [name, ...rest] = argv;
  if (name === "--version" || name === "-v" || name === "version") {
    c.log(version());
    return;
  }
  if (name === "help" && rest[0] !== undefined) {
    c.log(commandHelp(find(rest[0])));
    return;
  }
  if (name === undefined || name === "help" || isHelp(name)) {
    c.log(USAGE);
    return;
  }
  const command = find(name);
  if (asksHelp(rest)) {
    c.log(commandHelp(command));
    return;
  }
  const code = await command.run(c, rest);
  return code;
}

/** Runs one `aop` command. A usage or command failure is printed and becomes the exit code; anything else is thrown. */
export async function runCli(io: CliIo): Promise<void> {
  const log = (text: string) => {
    io.stdout.write(`${text}\n`);
  };
  const c: Ctx = { env: io.env, io, log, json: (value) => {
      log(JSON.stringify(value, null, 2));
    },
  };
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
