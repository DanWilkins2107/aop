/** Every `code` the API refuses a request with. */
export type ApiErrorCode =
  | "bad_request"
  | "not_found"
  | "refused"
  | "repo_path_not_absolute"
  | "repo_path_not_found"
  | "repo_path_taken"
  | "config_invalid"
  | "constraint_violation"
  | "forbidden_host"
  | "forbidden_origin"
  | "payload_too_large"
  | "path_not_allowed"
  | "internal_error";

/** The body of every error response. `config_invalid` carries the problems, as strings, in `details`. */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

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
  | "runs"
  | "schedule";

/** The routes under a project, as `/api/projects/:id/<action>`. */
export type ProjectAction = "nodes" | "edges";

/** The routes under an improvement, as `/api/improvements/:id/<action>`. */
export type ImprovementAction = "proposals" | "apply";

/** The routes under a run, as `/api/runs/:id/<action>`. */
export type RunAction = "stop" | "log" | "tail";
