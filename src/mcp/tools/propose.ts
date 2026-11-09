import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ProposalRequest, ProposalView } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { ACTOR, ApiFailure, defineTool } from "../tool.js";

/** The MCP server has no working directory, so a relative path has nothing to start from. */
export function absolutePath(path: string): string {
  if (!isAbsolute(path)) throw new ApiFailure(`Give an absolute path, not ${path}`);
  return resolve(path);
}

export const propose = defineTool({
  name: "propose",
  description:
    "Store a file's proposed new contents on an AOP improvement node: a skill, or a stage prompt. " +
    "The real file is unchanged: a human reviews the diff, and a later stage applies it. " +
    "Proposing the same path again replaces its proposal. A new skill is a new `SKILL.md` in its own folder.",
  input: {
    node_id: z.string().min(1).describe("The improvement node. Your own node's ID is in your prompt."),
    path: z.string().min(1).describe("The real file's absolute path."),
    content: z.string().describe("The file's full proposed contents."),
  },
  run: async ({ node_id, path, content }, api) => {
    const target = absolutePath(path);
    const proposal = await api.json<ProposalView>("PUT", apiPaths.improvementAction(node_id, "proposals"), {
      path: target,
      content,
      actor: ACTOR,
    } satisfies ProposalRequest);
    return `Proposed ${proposal.path}${proposal.current === null ? " (new file)" : ""}. The real file is unchanged.`;
  },
});
