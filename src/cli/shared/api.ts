import type { ApiErrorBody } from "../../shared/http/types.js";
import { API_PREFIX } from "../../shared/http/apiPrefix.js";
import { DEFAULT_PORT } from "../../shared/http/defaultPort.js";
import type { Ctx } from "./command.js";
import { CliFailure } from "./errors.js";

export const serverUrl = (c: Ctx) => c.env["AOP_URL"] ?? `http://127.0.0.1:${c.env["AOP_PORT"] ?? DEFAULT_PORT}`;

/** Something answered on the API's address, but not as the API does, such as the web UI's dev server. */
const notTheApi = (c: Ctx) => new CliFailure(`What answered at ${serverUrl(c)} isn't the AOP server's API. Check AOP_URL and AOP_PORT.`);

/** The API's own error, if that's what the body is. */
function apiError(text: string): { message: string; details?: unknown } | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: Partial<ApiErrorBody["error"]> };
    if (typeof error?.message === "string") return { message: error.message, details: error.details };
  } catch {
    // Not JSON, or JSON null.
  }
  return undefined;
}

/** Calls the API. A failure becomes the API's own message, or else its status. */
async function call(c: Ctx, method: string, path: string, body?: unknown): Promise<{ type: string; text: string }> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  // No run ID, even where AOP_RUN_ID is set: every command is the human's, not the run's or session's.
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${serverUrl(c)}${API_PREFIX}${path}`, init);
  } catch {
    throw new CliFailure(`Can't reach the AOP server at ${serverUrl(c)}. Is \`aop serve\` running?`);
  }
  const text = await response.text();
  if (!response.ok) {
    const error = apiError(text);
    let message = error?.message ?? `The server answered ${response.status}`;
    if (error?.details !== undefined) message += `\n${JSON.stringify(error.details)}`;
    throw new CliFailure(message);
  }
  return { type: response.headers.get("content-type") ?? "", text };
}

/** Calls the API, and reads its answer. Every route the CLI uses answers JSON. */
export async function send<T>(c: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const { type, text } = await call(c, method, path, body);
  if (!type.includes("json")) throw notTheApi(c);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw notTheApi(c);
  }
}
