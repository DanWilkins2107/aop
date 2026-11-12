import { z } from "zod";
import type { ActorRequest, EdgeRow } from "../../shared/nodes/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { ACTOR } from "../shared/actor.js";
import { defineTool } from "../shared/defineTool.js";
import { ApiFailure } from "../shared/toolApi.js";

export const edgeRemove = defineTool({
  name: "edge_remove",
  writes: true,
  description: "Remove a block between two AOP nodes, so `to` no longer waits for `from`.",
  input: {
    from: z.string().min(1).describe("The blocking node's ID."),
    to: z.string().min(1).describe("The blocked node's ID."),
  },
  run: async ({ from, to }, api) => {
    const edges = await api.json<EdgeRow[]>("GET", apiPaths.nodeAction(from, "edges"));
    const edge = edges.find((e) => e.kind === "blocks" && e.source_id === from && e.target_id === to);
    if (!edge) throw new ApiFailure(`${from} doesn't block ${to}`);
    await api.json<EdgeRow>("DELETE", apiPaths.edge(edge.id), { actor: ACTOR } satisfies ActorRequest);
    return `${from} no longer blocks ${to}`;
  },
});
