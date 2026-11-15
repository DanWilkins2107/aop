import type { Command } from "../../shared/command.js";
import { usageError } from "../../shared/errors.js";

const usage = [
  "aop init [--yes] [--fill-missing] [--if-new] [--agent-session-command <cmd>] [--out-of-sandbox-command <cmd>] [--open-from <dir>] [--create-open-from] [--agent-timeout-minutes <n>] [--stages <file>] [--improvements-path <dir>]",
];

/** Sets up AOP's home folder. The work is in `runInit.ts`, loaded only when the command runs. */
export const init: Command = {
  name: "init",
  usage,
  help: `Sets up AOP_HOME, or ~/.aop. Asks for each setting, unless a flag gives it.
  --yes                Don't ask. Settings not given by flags use their defaults.
  --fill-missing       Config exists: only add missing default files. Never overwrites.
  --if-new             Config exists: say so and change nothing, without failing.
  --stages <file>      Use your own stages file instead of the default setup.
  --create-open-from   Create the open_from folder if it doesn't exist.
  --improvements-path <dir>
                       The folder improvements may change. Default: ~/.aop/skills.`,
  async run(c, argv) {
    const { runInit } = await import("./runInit.js");
    return runInit(argv, { env: c.env, output: c.io.stdout, errors: c.io.stderr, usage: usageError(usage).message });
  },
};
