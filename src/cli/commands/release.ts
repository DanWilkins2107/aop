import type { ActorRequest, NodeView } from "../../shared/nodes/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { send } from "../shared/api.js";
import { args, only } from "../shared/args.js";
import type { Command } from "../shared/command.js";

const usage = ["aop release <node>"];

/** Every command is a human's. `actor` is self-reported. */
const HUMAN = "human";

/** Releases the human's claim on a node, so its stage can start again. */
export const release: Command = {
  name: "release",
  usage,
  async run(c, argv) {
    const id = only(args(argv, usage, {}).positionals, usage);
    await send<NodeView>(c, "POST", apiPaths.nodeAction(id, "release"), { actor: HUMAN } satisfies ActorRequest);
    c.log(`Released ${id}`);
  },
};
