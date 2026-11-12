import type { ImprovementAction, NodeAction, ProjectAction, RunAction } from "./types.js";

const one = (collection: string, id: string) => `/${collection}/${encodeURIComponent(id)}`;

/**
 * The API's paths below `API_PREFIX`, with IDs encoded, for the clients to call, so that none spells
 * them by hand. The server's route patterns for them are in `src/server/routes.ts`.
 */
export const apiPaths = {
  projects: "/projects",
  project: (id: string) => one("projects", id),
  projectAction: (id: string, action: ProjectAction) => `${one("projects", id)}/${action}`,
  node: (id: string) => one("nodes", id),
  nodeAction: (id: string, action: NodeAction) => `${one("nodes", id)}/${action}`,
  edge: (id: string) => one("edges", id),
  run: (id: string, action: RunAction) => `${one("runs", id)}/${action}`,
  search: "/search",
  health: "/health",
  /** Server-sent events: `change` whenever data changes, and `ready` on connecting. */
  events: "/events",
  agents: "/agents",
  reap: "/agents/reap",
  stages: "/stages",
  config: "/config",
  process: "/process",
  improvementStages: "/improvement-stages",
  improvements: "/improvements",
  improvement: (id: string) => one("improvements", id),
  improvementAction: (id: string, action: ImprovementAction) => `${one("improvements", id)}/${action}`,
} as const;
