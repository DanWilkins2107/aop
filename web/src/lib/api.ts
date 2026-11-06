import type {
  AddProjectRequest,
  AnswerRequest,
  BlockRequest,
  ConfigView,
  CreateNodeRequest,
  EdgeRequest,
  EdgeRow,
  EditNodeRequest,
  EventView,
  InvalidateRequest,
  LinkRow,
  MessageRequest,
  MessageRow,
  MoveRequest,
  NextRequest,
  NodeView,
  ProjectRow,
  ProcessView,
  StagesView,
  UpdateProjectRequest,
} from "../../../src/shared/api.js";

/** A refusal from the API, or a failure to reach it. */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

interface ErrorBody {
  error?: { code: string; message: string; details?: unknown };
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiFailure("Can't reach the AOP server", "unreachable");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as ErrorBody | null)?.error;
    throw new ApiFailure(error?.message ?? `Request failed (${response.status})`, error?.code ?? "unknown", error?.details);
  }
  return payload as T;
}

const nodePath = (id: string) => `/nodes/${encodeURIComponent(id)}`;
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const api = {
  projects: () => send<ProjectRow[]>("GET", "/projects"),
  addProject: (name: string, repoPath: string | null) => send<ProjectRow>("POST", "/projects", { name, repo_path: repoPath } satisfies AddProjectRequest),
  updateProject: (id: string, changes: UpdateProjectRequest) =>
    send<ProjectRow>("PATCH", projectPath(id), changes),
  deleteProject: (id: string) => send<ProjectRow>("DELETE", projectPath(id)),
  nodes: (projectId: string) => send<NodeView[]>("GET", `${projectPath(projectId)}/nodes`),
  projectEdges: (projectId: string) => send<EdgeRow[]>("GET", `${projectPath(projectId)}/edges`),
  stages: () => send<StagesView>("GET", "/stages"),
  config: () => send<ConfigView>("GET", "/config"),
  process: () => send<ProcessView>("GET", "/process"),
  createNode: (projectId: string, body: CreateNodeRequest) =>
    send<NodeView>("POST", `${projectPath(projectId)}/nodes`, body),

  node: (id: string) => send<NodeView>("GET", nodePath(id)),
  messages: (id: string) => send<MessageRow[]>("GET", `${nodePath(id)}/messages`),
  events: (id: string) => send<EventView[]>("GET", `${nodePath(id)}/events`),
  links: (id: string) => send<LinkRow[]>("GET", `${nodePath(id)}/links`),
  edges: (id: string) => send<EdgeRow[]>("GET", `${nodePath(id)}/edges`),

  editBody: (id: string, body: string) => send<NodeView>("PATCH", nodePath(id), { body } satisfies EditNodeRequest),
  next: (id: string, outcome: string) => send<NodeView>("POST", `${nodePath(id)}/next`, { outcome } satisfies NextRequest),
  answer: (id: string, answer: string) => send<NodeView>("POST", `${nodePath(id)}/answer`, { answer } satisfies AnswerRequest),
  retry: (id: string) => send<NodeView>("POST", `${nodePath(id)}/retry`),
  invalidate: (id: string, reason: string) => send<NodeView>("POST", `${nodePath(id)}/invalidate`, { reason } satisfies InvalidateRequest),
  restore: (id: string) => send<NodeView>("POST", `${nodePath(id)}/restore`),
  block: (id: string, reason: string) => send<NodeView>("POST", `${nodePath(id)}/block`, { reason } satisfies BlockRequest),
  unblock: (id: string) => send<NodeView>("POST", `${nodePath(id)}/unblock`),
  claim: (id: string) => send<NodeView>("POST", `${nodePath(id)}/claim`),
  release: (id: string) => send<NodeView>("POST", `${nodePath(id)}/release`),
  move: (id: string, body: MoveRequest) =>
    send<NodeView>("POST", `${nodePath(id)}/move`, body),
  addMessage: (id: string, body: string) => send<MessageRow>("POST", `${nodePath(id)}/messages`, { body } satisfies MessageRequest),
  addEdge: (sourceId: string, targetId: string, kind: EdgeRequest["kind"]) =>
    send<EdgeRow>("POST", `${nodePath(sourceId)}/edges`, { target_id: targetId, kind } satisfies EdgeRequest),
  stopRun: (runId: string) => send<NodeView>("POST", `/runs/${encodeURIComponent(runId)}/stop`),
  removeEdge: (edgeId: string) => send<EdgeRow>("DELETE", `/edges/${encodeURIComponent(edgeId)}`),
};

/** The message to show for a failed action. */
export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
