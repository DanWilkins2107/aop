import { z } from "zod";
import { apiPaths } from "../../shared/paths.js";
import { defineTool } from "../tool.js";

export const context = defineTool({
  name: "context",
  description:
    "Read an AOP node: its stage, ancestors, children, siblings, blocks, description, messages, links, and the outcomes " +
    'that can finish its current stage (under "Moving on"). Call it first, with your own node\'s ID, before starting ' +
    "work, and again after a split or a long task. Works on any node, such as one found by search.",
  input: {
    node_id: z.string().min(1).describe("The node to read. Your own node's ID is in your prompt."),
  },
  annotations: { readOnlyHint: true },
  run: ({ node_id }, api) => api.text(apiPaths.nodeAction(node_id, "context")),
});
