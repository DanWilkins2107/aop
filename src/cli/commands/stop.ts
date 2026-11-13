import type { NodeView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { send } from "../shared/api.js";
import { args, only } from "../shared/args.js";
import type { Command } from "../shared/command.js";
import { CliFailure } from "../shared/errors.js";

const usage = ["aop stop <node>"];

/** Stops the agent running on a node, as the UI's Stop run does. The node stays put, claimed by the human. */
export const stop: Command = {
  name: "stop",
  usage,
  async run(c, argv) {
    const id = only(args(argv, usage, {}).positionals, usage);
    const node = await send<NodeView>(c, "GET", apiPaths.node(id));
    if (node.run_id === null) throw new CliFailure(`No agent is running on ${id}`);
    const stopped = await send<NodeView>(c, "POST", apiPaths.run(node.run_id, "stop"));
    c.log(`Stopped ${node.run_id}. ${id} stays at ${stopped.stage}, claimed by you. Run \`aop release ${id}\` to start the stage again.`);
  },
};
