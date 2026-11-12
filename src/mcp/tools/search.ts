import { z } from "zod";
import type { NodeView, SearchResult } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { defineTool } from "../shared/defineTool.js";

export const search = defineTool({
  name: "search",
  description:
    "Search AOP nodes' titles, descriptions and messages. Searches your own node's project, or every project with " +
    "`all` (an improvement node, which belongs to no project, always searches every project). Each result gives the " +
    "node's ID, stage and title, then the matching text with the matched words in [brackets]. Read a result with the `context` tool.",
  input: {
    query: z.string().min(1).describe("The words to search for. A node matches if it has all of them."),
    node_id: z.string().min(1).describe("Your own node's ID, from your prompt. Its project is the one searched."),
    all: z.boolean().optional().describe("Search every project, not just your node's."),
  },
  annotations: { readOnlyHint: true },
  run: async ({ query, node_id, all }, api) => {
    const params = new URLSearchParams({ q: query });
    const node = await api.json<NodeView>("GET", apiPaths.node(node_id));
    // An improvement belongs to no project, so it searches them all.
    if (all !== true && node.kind !== "improvement") params.set("project", node.project_id);
    const results = await api.json<SearchResult[]>("GET", `${apiPaths.search}?${params}`);
    if (results.length === 0) return "No matches.";
    return results
      .map((result) => `${result.node_id}  [${result.stage}]  ${result.title}\n    ${result.snippet.replace(/\s+/g, " ")}`)
      .join("\n");
  },
});
