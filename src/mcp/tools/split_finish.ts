import { z } from "zod";
import type { NodeView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { defineTool } from "../tool.js";

export const splitFinish = defineTool({
  name: "split_finish",
  description:
    "End the split begun with `split_start`. The node becomes `broken_down` and its children start. " +
    "It needs at least one child, and the node's own blocks moved to the children they apply to. " +
    "This ends your turn: stop working once you've called it.",
  input: {
    node_id: z.string().min(1).describe("The node being split. Your own node's ID is in your prompt."),
  },
  run: async ({ node_id }, api) => {
    const node = await api.json<NodeView>("POST", apiPaths.nodeAction(node_id, "split/finish"));
    return `${node.id} is now at ${node.stage}`;
  },
});
