/**
 * The API's paths, for the server to route and the clients to call, so that neither spells them by hand.
 * Plain functions with no imports, so that the browser can use this file too.
 */

export const API_PREFIX = "/api";

/** The routes under a node, as `/api/nodes/:id/<action>`. */
export type NodeAction =
  | "context"
  | "steer"
  | "next"
  | "move"
  | "ask"
  | "answer"
  | "fail"
  | "retry"
  | "invalidate"
  | "restore"
  | "block"
  | "unblock"
  | "split/start"
  | "split/finish"
  | "claim"
  | "release"
  | "messages"
  | "links"
  | "edges"
  | "events"
  | "runs";

/** The routes under a project, as `/api/projects/:id/<action>`. */
export type ProjectAction = "nodes" | "edges";

/** The routes under an improvement, as `/api/improvements/:id/<action>`. */
export type ImprovementAction = "proposals" | "apply";

/** The routes under a run, as `/api/runs/:id/<action>`. */
export type RunAction = "stop" | "log" | "tail";

const one = (collection: string, id: string) => `/${collection}/${encodeURIComponent(id)}`;

/** Paths below `API_PREFIX`, with IDs encoded, for the clients. */
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

/**
 * The same paths as route patterns, with `:id` for the ID, for the server. Typed as literals, so
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
