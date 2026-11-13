import type { AgentProcessView } from "../../shared/runs/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { send } from "../shared/api.js";
import { none } from "../shared/args.js";
import type { Command } from "../shared/command.js";

const usage = ["aop ps"];

/** Lists the agent processes the server knows of. */
export const ps: Command = {
  name: "ps",
  usage,
  async run(c, argv) {
    none(argv, usage);
    const agents = await send<AgentProcessView[]>(c, "GET", apiPaths.agents);
    if (agents.length === 0) {
      c.log("No agents running.");
      return;
    }
    for (const agent of agents) {
      const identity = agent.identity === "confirmed" ? "" : "  (unverified)";
      const where = agent.node_title === null ? "(node deleted)" : `[${agent.stage}] ${agent.node_title}`;
      c.log(`${agent.run_id}  pid ${agent.pid}  ${agent.status}${identity}  node ${agent.node_id}  ${where}`);
    }
  },
};
