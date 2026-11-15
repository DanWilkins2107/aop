import type { ActorRequest, NodeView } from "../../shared/nodes/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { send } from "../shared/api.js";
import { args, JSON_OPTION, only } from "../shared/args.js";
import type { Command } from "../shared/command.js";

const usage = ["aop release <node> [--json]"];

/** Every command is a human's. `actor` is self-reported. */
const HUMAN = "human";

/** Releases the human's claim on a node, so its stage can start again. */
export const release: Command = {
  name: "release",
  usage,
  async run(c, argv) {
    const { values, positionals } = args(argv, usage, JSON_OPTION);
    const id = only(positionals, usage);
    const node = await send<NodeView>(c, "POST", apiPaths.nodeAction(id, "release"), { actor: HUMAN } satisfies ActorRequest);
    if (values.json === true) return c.json(node);
    c.log(`Released ${id}`);
  },
};
