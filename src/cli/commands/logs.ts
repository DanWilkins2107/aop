import type { LogTail, NodeView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { send } from "../shared/api.js";
import { args, only } from "../shared/args.js";
import type { Command } from "../shared/command.js";
import { CliFailure, usageError } from "../shared/errors.js";

const usage = ["aop logs <node> [--lines N]"];

/** How much of a log `aop logs` prints unless asked for more or less. */
const DEFAULT_LOG_LINES = 50;

/**
 * Prints the end of the node's latest run's log, as the node page shows it: the agent's readable
 * output, which for stream-json means its text rather than the raw events.
 */
export const logs: Command = {
  name: "logs",
  usage,
  async run(c, argv) {
    const { values, positionals } = args(argv, usage, { lines: { type: "string" } });
    const id = only(positionals, usage);
    const lines = values.lines === undefined ? DEFAULT_LOG_LINES : Number(values.lines);
    if (!Number.isInteger(lines) || lines < 1) throw usageError(usage, "--lines must be a whole number above 0");
    const node = await send<NodeView>(c, "GET", apiPaths.node(id));
    if (node.last_run_id === null) throw new CliFailure(`${id} has had no runs yet`);
    const tail = await send<LogTail>(c, "GET", `${apiPaths.run(node.last_run_id, "tail")}?lines=${lines}`);
    if (tail.lines.length === 0) {
      c.log(`The log for ${node.last_run_id} is empty so far.`);
      return;
    }
    c.log(tail.lines.join("\n"));
  },
};
