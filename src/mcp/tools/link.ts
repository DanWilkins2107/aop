import { z } from "zod";
import type { LinkRequest, LinkRow } from "../../shared/nodes/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { ACTOR } from "../shared/actor.js";
import { defineTool } from "../shared/defineTool.js";

export const link = defineTool({
  name: "link",
  writes: true,
  description: "Attach a PR or ticket link to an AOP node.",
  input: {
    node_id: z.string().min(1).describe("The node to link. Your own node's ID is in your prompt."),
    kind: z.enum(["pr", "ticket"]).describe("What the link is: a pull request or a ticket."),
    url: z.string().min(1).describe("The link's URL, starting with http:// or https://."),
  },
  run: async ({ node_id, kind, url }, api) => {
    await api.json<LinkRow>("POST", apiPaths.nodeAction(node_id, "links"), { kind, url, actor: ACTOR } satisfies LinkRequest);
    return `Linked ${kind} ${url}`;
  },
});
