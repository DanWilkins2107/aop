// How every MCP tool reaches the board: a call into the API in-process. Tools never reach the
// database themselves, so validation, `applyStageChange`, change notices, the event log and the run
// guard all stay on the API's path.

import type { Hono } from "hono";
import { z } from "zod";
import { RUN_ID_HEADER } from "../../shared/runs/runIdHeader.js";
import { API_PREFIX } from "../../shared/http/apiPrefix.js";
import { ApiFailure } from "./ApiFailure.js";
import type { ToolApi } from "./types.js";

/** The API's error body. */
const ApiError = z.object({ error: z.object({ message: z.string(), details: z.unknown().optional() }) });

/** The API's own error message, with its details if it gave any. */
function failureOf(status: number, text: string): ApiFailure {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = ApiError.safeParse(body);
  if (!parsed.success) return new ApiFailure(`The AOP server answered ${status}`);
  const { message, details } = parsed.data.error;
  return new ApiFailure(details === undefined ? message : `${message}\n${JSON.stringify(details)}`);
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
      // The API's answer is typed by the contract in src/shared, so it isn't checked again here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
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
