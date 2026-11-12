import { z } from "zod";
import type { EdgeRequest, EdgeRow } from "../../shared/nodes/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { ACTOR } from "../shared/actor.js";
import { defineTool } from "../shared/defineTool.js";

export const edgeAdd = defineTool({
  name: "edge_add",
  writes: true,
  description: "Make one AOP node block another: `from` must finish before `to` starts.",
  input: {
    from: z.string().min(1).describe("The blocking node's ID, which must finish first."),
    to: z.string().min(1).describe("The blocked node's ID, which waits for `from`."),
  },
  run: async ({ from, to }, api) => {
    await api.json<EdgeRow>("POST", apiPaths.nodeAction(from, "edges"), {
      target_id: to,
      kind: "blocks",
      actor: ACTOR,
    } satisfies EdgeRequest);
    return `${from} now blocks ${to}`;
  },
});
