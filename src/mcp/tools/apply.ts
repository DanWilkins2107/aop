import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ApplyRequest, ApplyResult } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { ACTOR, ApiFailure, defineTool } from "../tool.js";

export const apply = defineTool({
  name: "apply",
  description:
    "Write an improvement's proposals: to the real files at `save_locally`, or with `into`, into a worktree at `raise_pr`. " +
    "With `into`, files outside the repo are skipped. If it refuses, ask with what it said; don't write the files yourself.",
  input: {
    node_id: z.string().min(1).describe("The improvement node to apply. Your own node's ID is in your prompt."),
    into: z
      .string()
      .min(1)
      .optional()
      .describe("At `raise_pr` only: the full path of the git worktree to write the proposals into."),
  },
  run: async ({ node_id, into }, api) => {
    if (into !== undefined && !isAbsolute(into)) throw new ApiFailure(`into must be a full path: ${into}`);
    const result = await api.json<ApplyResult>("POST", apiPaths.improvementAction(node_id, "apply"), {
      actor: ACTOR,
      ...(into !== undefined ? { into } : {}),
    } satisfies ApplyRequest);
    return [
      ...result.written.map((path) => `Wrote ${path}`),
      ...result.skipped.map((path) => `Skipped ${path}: it's outside the repo`),
    ].join("\n");
  },
});
