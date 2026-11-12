import { z } from "zod";
import type { NextRequest } from "../../shared/stages/types.js";
import type { NodeView } from "../../shared/nodes/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { ACTOR } from "../shared/actor.js";
import { defineTool } from "../shared/defineTool.js";

export const next = defineTool({
  name: "next",
  writes: true,
  description:
    "Finish an AOP node's current stage with one outcome, one of those listed under \"Moving on\" in the `context` tool. " +
    "This ends your turn: stop working once you've called it.",
  input: {
    node_id: z.string().min(1).describe("The node to move on. Your own node's ID is in your prompt."),
    outcome: z.string().min(1).describe('One of the outcomes under "Moving on" in the node\'s context.'),
  },
  run: async ({ node_id, outcome }, api) => {
    const node = await api.json<NodeView>("POST", apiPaths.nodeAction(node_id, "next"), { outcome, actor: ACTOR } satisfies NextRequest);
    return `${node.id} is now at ${node.stage}`;
  },
});
