import { API_PREFIX } from "../shared/http/apiPrefix.js";
import type { ImprovementAction, NodeAction, ProjectAction, RunAction } from "../shared/http/types.js";

/**
 * The paths in `apiPaths`, as route patterns, with `:id` for the ID, for the server. Typed as literals, so
 * that the router knows each route has an `id`.
 */
export const routes = {
  project: `${API_PREFIX}/projects/:id`,
  projectAction: <A extends ProjectAction>(action: A) => `${API_PREFIX}/projects/:id/${action}` as const,
  node: `${API_PREFIX}/nodes/:id`,
  nodeAction: <A extends NodeAction>(action: A) => `${API_PREFIX}/nodes/:id/${action}` as const,
  edge: `${API_PREFIX}/edges/:id`,
  run: <A extends RunAction>(action: A) => `${API_PREFIX}/runs/:id/${action}` as const,
  improvement: `${API_PREFIX}/improvements/:id`,
  improvementAction: <A extends ImprovementAction>(action: A) => `${API_PREFIX}/improvements/:id/${action}` as const,
} as const;
