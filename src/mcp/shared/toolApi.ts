// How every MCP tool reaches the board: a call into the API in-process. Tools never reach the
// database themselves, so validation, `applyStageChange`, change notices, the event log and the run
// guard all stay on the API's path.

import type { Hono } from "hono";
import { RUN_ID_HEADER, type ApiErrorBody } from "../../shared/api.js";
import { API_PREFIX } from "../../shared/paths.js";

/** The API, as a tool sees it. A refusal or any other failure is thrown as an `ApiFailure`. */
export interface ToolApi {
  /** A JSON route's answer. */
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** A text/plain route's answer, such as a node's context. */
  text(path: string): Promise<string>;
  /**
   * The same API, with every call sent as from this run, in `RUN_ID_HEADER`. The server then refuses
   * writes from a run that has ended, and stage changes from any run but the one on that node.
   */
  asRun(runId: string): ToolApi;
}

/** The API refused, or failed. Its message becomes the tool's error, which the agent reads. */
export class ApiFailure extends Error {}

/** The API's own error message, with its details if it gave any. */
function failureOf(status: number, text: string): ApiFailure {
  try {
    const { error } = JSON.parse(text) as { error?: Partial<ApiErrorBody["error"]> };
    if (typeof error?.message === "string") {
      return new ApiFailure(error.details === undefined ? error.message : `${error.message}\n${JSON.stringify(error.details)}`);
    }
  } catch {
    // Not JSON.
  }
  return new ApiFailure(`The AOP server answered ${status}`);
}

/** Calls the API app in-process. Paths are below `API_PREFIX`, as `apiPaths` gives them. No run ID is sent unless `asRun` gives one. */
export function toolApi(api: Hono, runId?: string): ToolApi {
  const call = async (method: string, path: string, body?: unknown): Promise<{ type: string; text: string }> => {
    // The API only answers requests addressed to localhost.
    const headers: Record<string, string> = { host: "127.0.0.1" };
    if (runId !== undefined) headers[RUN_ID_HEADER] = runId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await api.request(`${API_PREFIX}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw failureOf(response.status, text);
    return { type: response.headers.get("content-type") ?? "", text };
  };
  return {
    async json<T>(method: string, path: string, body?: unknown) {
      const { type, text } = await call(method, path, body);
      if (!type.includes("json")) throw new ApiFailure(`Expected JSON from ${path}, got ${type || "nothing"}`);
      return JSON.parse(text) as T;
    },
    async text(path) {
      return (await call("GET", path)).text;
    },
    asRun(id) {
      return toolApi(api, id);
    },
  };
}
