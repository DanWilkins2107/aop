import type { ReapResult } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { send } from "../shared/api.js";
import { none } from "../shared/args.js";
import type { Command } from "../shared/command.js";

const usage = ["aop reap"];

/** Asks the server to kill the agent processes it has lost track of, and says what it did. */
export const reap: Command = {
  name: "reap",
  usage,
  async run(c, argv) {
    none(argv, usage);
    const result = await send<ReapResult>(c, "POST", apiPaths.reap);
    if (result.killed.length === 0) c.log("Nothing to reap.");
    for (const { run_id, pid, reason } of result.killed) c.log(`Killed ${run_id} (pid ${pid}): ${reason}`);
    for (const { run_id, pid, reason } of result.skipped) c.log(`Left alone ${run_id} (pid ${pid}): ${reason}`);
  },
};
