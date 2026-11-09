import { z } from "zod";
import type { ProposalView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { ApiFailure, defineTool } from "../tool.js";

export const proposals = defineTool({
  name: "proposals",
  description:
    "List an AOP improvement node's proposals: the files it would change, each a new file or a change to an existing " +
    "one, and whether the real file has changed since. With `show`, return one proposal's proposed contents instead. " +
    "Proposals are only stored in AOP: the real files are unchanged until they're applied.",
  input: {
    node_id: z.string().min(1).describe("Your own improvement node's ID, from your prompt."),
    show: z
      .string()
      .min(1)
      .optional()
      .describe("A proposal to print: its absolute path, or its path relative to the improvements folder."),
  },
  annotations: { readOnlyHint: true },
  run: async ({ node_id, show }, api) => {
    const list = await api.json<ProposalView[]>("GET", apiPaths.improvementAction(node_id, "proposals"));
    if (show !== undefined) {
      // No working directory here, so a relative path only matches a display path.
      const wanted = show.toLowerCase();
      const proposal = list.find((p) => p.path.toLowerCase() === wanted || p.display_path === show);
      if (!proposal) throw new ApiFailure(`No proposal for ${show}`);
      return proposal.proposed;
    }
    if (list.length === 0) return "No proposals.";
    return list
      .map((p) => {
        const what = p.current === null ? "new file" : "changes the file";
        return `${p.path}  (${what}, last by ${p.updated_by}${p.stale ? "; the file has changed since" : ""})`;
      })
      .join("\n");
  },
});
