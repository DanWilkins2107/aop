import { z } from "zod";
import type { EditNodeRequest, NodeView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { ACTOR, defineTool } from "../tool.js";

export const nodeEdit = defineTool({
  name: "node_edit",
  description: "Edit an AOP node's title or description, usually your own. Give a new title, a new body, or both.",
  input: {
    node_id: z.string().min(1).describe("The node to edit. Your own node's ID is in your prompt."),
    title: z.string().optional().describe("The node's new title."),
    body: z.string().optional().describe("The node's new description, replacing the old one whole."),
  },
  run: async ({ node_id, title, body }, api) => {
    if (title === undefined && body === undefined) {
      return { content: [{ type: "text", text: "Give a title, a body, or both." }], isError: true };
    }
    await api.json<NodeView>("PATCH", apiPaths.node(node_id), {
      actor: ACTOR,
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
    } satisfies EditNodeRequest);
    return `Edited ${node_id}`;
  },
});
