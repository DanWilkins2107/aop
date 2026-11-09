import { z } from "zod";
import type { MessageRequest, MessageRow } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { ACTOR, defineTool } from "../tool.js";

export const message = defineTool({
  name: "message",
  description: "Post a message on an AOP node, usually your own and sometimes another's. It shows in the node's messages in `context`.",
  input: {
    node_id: z.string().min(1).describe("The node to post on. Your own node's ID is in your prompt."),
    body: z.string().min(1).describe("The message to post."),
  },
  run: async ({ node_id, body }, api) => {
    const posted = await api.json<MessageRow>("POST", apiPaths.nodeAction(node_id, "messages"), { body, author: ACTOR } satisfies MessageRequest);
    return `Posted to ${posted.node_id}`;
  },
});
