import { z } from "zod";
import type { FailRequest, NodeView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { ACTOR } from "../shared/actor.js";
import { defineTool } from "../shared/defineTool.js";

export const fail = defineTool({
  name: "fail",
  writes: true,
  description:
    "Mark an AOP node failed, with the reason in its messages for the human who picks it up. " +
    "Use it only when the work can't be done and asking a human won't help. " +
    "This ends your turn: stop working once you've called it.",
  input: {
    node_id: z.string().min(1).describe("The node to mark failed. Your own node's ID is in your prompt."),
    reason: z.string().min(1).describe("Why the work can't be done, for the human who picks the node up."),
  },
  run: async ({ node_id, reason }, api) => {
    const node = await api.json<NodeView>("POST", apiPaths.nodeAction(node_id, "fail"), { reason, actor: ACTOR } satisfies FailRequest);
    return `${node.id} is now at ${node.stage}`;
  },
});
