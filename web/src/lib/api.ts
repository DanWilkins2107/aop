// The browser's client for the HTTP API: one function per route the UI uses.

import type {
  AddProjectRequest,
  AnswerRequest,
  ApiErrorBody,
  ApiErrorCode,
  BlockRequest,
  ConfigView,
  CreateNodeRequest,
  EdgeRequest,
  EdgeRow,
  EditNodeRequest,
  EventView,
  InvalidateRequest,
  LinkRow,
  LogTail,
  MessageRequest,
  MessageRow,
  MoveRequest,
  NextRequest,
  NodeView,
  ProjectRow,
  ProcessView,
  RunView,
  StagesView,
  UpdateProjectRequest,
} from "../../../src/shared/api.js";
import { API_PREFIX, apiPaths } from "../../../src/shared/paths.js";

/** A refusal from the API, or a failure to reach it, or an answer that isn't the API's error shape. */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | "unreachable" | "unknown",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    response = await fetch(`${API_PREFIX}${path}`, init);
  } catch {
    throw new ApiFailure("Can't reach the AOP server", "unreachable");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as Partial<ApiErrorBody> | null)?.error;
    throw new ApiFailure(error?.message ?? `Request failed (${response.status})`, error?.code ?? "unknown", error?.details);
  }
  return payload as T;
}

/** Addresses the browser opens itself, rather than through `send`. */
export const urls = {
  events: `${API_PREFIX}${apiPaths.events}`,
  runLog: (runId: string) => `${API_PREFIX}${apiPaths.run(runId, "log")}`,
};

export const api = {
  projects: () => send<ProjectRow[]>("GET", apiPaths.projects),
  addProject: (name: string, repoPath: string | null) => send<ProjectRow>("POST", apiPaths.projects, { name, repo_path: repoPath } satisfies AddProjectRequest),
  updateProject: (id: string, changes: UpdateProjectRequest) =>
    send<ProjectRow>("PATCH", apiPaths.project(id), changes),
  deleteProject: (id: string) => send<ProjectRow>("DELETE", apiPaths.project(id)),
  nodes: (projectId: string) => send<NodeView[]>("GET", apiPaths.projectAction(projectId, "nodes")),
  projectEdges: (projectId: string) => send<EdgeRow[]>("GET", apiPaths.projectAction(projectId, "edges")),
  stages: () => send<StagesView>("GET", apiPaths.stages),
  config: () => send<ConfigView>("GET", apiPaths.config),
  process: () => send<ProcessView>("GET", apiPaths.process),
  createNode: (projectId: string, body: CreateNodeRequest) =>
    send<NodeView>("POST", apiPaths.projectAction(projectId, "nodes"), body),

  node: (id: string) => send<NodeView>("GET", apiPaths.node(id)),
  messages: (id: string) => send<MessageRow[]>("GET", apiPaths.nodeAction(id, "messages")),
  events: (id: string) => send<EventView[]>("GET", apiPaths.nodeAction(id, "events")),
  links: (id: string) => send<LinkRow[]>("GET", apiPaths.nodeAction(id, "links")),
  edges: (id: string) => send<EdgeRow[]>("GET", apiPaths.nodeAction(id, "edges")),

  editBody: (id: string, body: string) => send<NodeView>("PATCH", apiPaths.node(id), { body } satisfies EditNodeRequest),
  next: (id: string, outcome: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "next"), { outcome } satisfies NextRequest),
  answer: (id: string, answer: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "answer"), { answer } satisfies AnswerRequest),
  retry: (id: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "retry")),
  invalidate: (id: string, reason: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "invalidate"), { reason } satisfies InvalidateRequest),
  restore: (id: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "restore")),
  block: (id: string, reason: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "block"), { reason } satisfies BlockRequest),
  unblock: (id: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "unblock")),
  claim: (id: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "claim")),
  release: (id: string) => send<NodeView>("POST", apiPaths.nodeAction(id, "release")),
  move: (id: string, body: MoveRequest) =>
    send<NodeView>("POST", apiPaths.nodeAction(id, "move"), body),
  addMessage: (id: string, body: string) => send<MessageRow>("POST", apiPaths.nodeAction(id, "messages"), { body } satisfies MessageRequest),
  addEdge: (sourceId: string, targetId: string, kind: EdgeRequest["kind"]) =>
    send<EdgeRow>("POST", apiPaths.nodeAction(sourceId, "edges"), { target_id: targetId, kind } satisfies EdgeRequest),
  runs: (id: string) => send<RunView[]>("GET", apiPaths.nodeAction(id, "runs")),
  logTail: (runId: string) => send<LogTail>("GET", apiPaths.run(runId, "tail")),
  stopRun: (runId: string) => send<NodeView>("POST", apiPaths.run(runId, "stop")),
  removeEdge: (edgeId: string) => send<EdgeRow>("DELETE", apiPaths.edge(edgeId)),
};

/** A project's whole graph, with the stages and the project itself. The graph page and the node page both need it. */
export async function loadProjectGraph(projectId: string) {
  const [nodes, edges, stages, projects] = await Promise.all([
    api.nodes(projectId),
    api.projectEdges(projectId),
    api.stages(),
    api.projects(),
  ]);
  return { nodes, edges, stages, project: projects.find((p) => p.id === projectId) ?? null };
}

/** The message to show for a failed action. */
export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
