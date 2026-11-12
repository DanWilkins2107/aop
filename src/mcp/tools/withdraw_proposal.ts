import { z } from "zod";
import type { WithdrawRequest } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { absolutePath } from "../shared/absolutePath.js";
import { ACTOR } from "../shared/actor.js";
import { defineTool } from "../shared/defineTool.js";

export const withdrawProposal = defineTool({
  name: "withdraw_proposal",
  writes: true,
  description: "Drop a file's proposal from an AOP improvement node, for a file that no longer belongs in the change.",
  input: {
    node_id: z.string().min(1).describe("The improvement node. Your own node's ID is in your prompt."),
    path: z.string().min(1).describe("The real file's absolute path, as it was proposed."),
  },
  run: async ({ node_id, path }, api) => {
    const target = absolutePath(path);
    await api.json("DELETE", apiPaths.improvementAction(node_id, "proposals"), { path: target, actor: ACTOR } satisfies WithdrawRequest);
    return `Withdrew the proposal for ${target}`;
  },
});
