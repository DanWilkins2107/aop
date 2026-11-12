import { z } from "zod";
import type { AskRequest } from "../../shared/stages/types.js";
import type { NodeView } from "../../shared/nodes/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { defineTool } from "../shared/defineTool.js";

export const ask = defineTool({
  name: "ask",
  writes: true,
  description:
    "Ask a human a question about an AOP node. The node waits for the answer, then its current stage restarts with the answer in its messages. " +
    "This ends your turn: stop working once you've called it.",
  input: {
    node_id: z.string().min(1).describe("The node to ask about. Your own node's ID is in your prompt."),
    question: z.string().min(1).describe("The question for the human, complete enough to answer without other context."),
  },
  run: async ({ node_id, question }, api) => {
    const node = await api.json<NodeView>("POST", apiPaths.nodeAction(node_id, "ask"), { question } satisfies AskRequest);
    return `${node.id} is now at ${node.stage}`;
  },
});
