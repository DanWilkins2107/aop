import type { Command } from "../../shared/command.js";
import { usageError } from "../../shared/errors.js";

const usage = [
  "aop init [--yes] [--fill-missing] [--if-new] [--agent-session-command <cmd>] [--out-of-sandbox-command <cmd>] [--open-from <dir>] [--create-open-from] [--agent-timeout-minutes <n>] [--stages <file>] [--improvements-path <dir>]",
];

/** Sets up AOP's home folder. The work is in `runInit.ts`, loaded only when the command runs. */
export const init: Command = {
  name: "init",
  usage,
  async run(c, argv) {
    const { runInit } = await import("./runInit.js");
    return runInit(argv, { env: c.env, output: c.io.stdout, errors: c.io.stderr, usage: usageError(usage).message });
  },
};
