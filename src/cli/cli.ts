// `aop`. It finds the command in `commands/registry.ts` and runs it. Every command is an HTTP call
// to the server, except `init` and `serve`, which runs the server in this process.
// `main.ts` runs it on the real process. Tests run it in-process through `runCli`, with their own environment and output.

import { DEFAULT_PORT } from "../shared/http/defaultPort.js";
import { MCP_PORT } from "../shared/http/mcpPort.js";
import { COMMANDS, HUMAN_COMMANDS } from "./commands/registry.js";
import type { CliIo, Ctx } from "./shared/command.js";
import { CliFailure, UsageError } from "./shared/errors.js";

const USAGE = `aop: agent orchestration platform

${Object.values(HUMAN_COMMANDS)
  .flat()
  .map((line) => `  ${line}`)
  .join("\n")}

Agents use AOP's MCP server at http://127.0.0.1:${MCP_PORT}/mcp.

Finds the server through AOP_URL, or AOP_PORT on localhost, or else port ${DEFAULT_PORT}.`;

/** Runs a command, and gives its exit code when it isn't 0. */
async function run(c: Ctx, argv: string[]): Promise<number | void> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    c.log(USAGE);
    return;
  }
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) throw new UsageError(`Unknown command "${name}"\n\n${USAGE}`);
  return command.run(c, rest);
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
