import { z } from "zod";
import type { NodeView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { defineTool } from "../tool.js";

export const splitStart = defineTool({
  name: "split_start",
  writes: true,
  description:
    "Begin splitting an AOP node into children, from an agent stage. Children you create afterwards are held, so they don't start, " +
    "until you call `split_finish`. Your turn continues.",
  input: {
    node_id: z.string().min(1).describe("The node to split. Your own node's ID is in your prompt."),
  },
  run: async ({ node_id }, api) => {
    const node = await api.json<NodeView>("POST", apiPaths.nodeAction(node_id, "split/start"));
    return `${node.id} is now at ${node.stage}`;
  },
});
