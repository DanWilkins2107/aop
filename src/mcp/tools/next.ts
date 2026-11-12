import { z } from "zod";
import type { NextRequest, NodeView } from "../../shared/api/types.js";
import { apiPaths } from "../../shared/api/paths.js";
import { ACTOR, defineTool } from "../tool.js";

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
