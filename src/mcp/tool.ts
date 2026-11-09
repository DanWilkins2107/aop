// What every MCP tool is built from: a call into the API in-process, as the CLI makes over HTTP, and
// the API's answers and errors turned into tool results. Tools never reach the database themselves,
// so validation, `applyStageChange`, change notices and the event log all stay on the API's path.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { ApiErrorBody } from "../shared/api.js";
import { API_PREFIX } from "../shared/paths.js";

/** Every write a tool makes says it's the agent's, as the CLI's agent commands do. */
export const ACTOR = "agent";

/** The API, as a tool sees it. A refusal or any other failure is thrown as an `ApiFailure`. */
export interface ToolApi {
  /** A JSON route's answer. */
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** A text/plain route's answer, such as a node's context. */
  text(path: string): Promise<string>;
}

/** The API refused, or failed. Its message becomes the tool's error, which the agent reads. */
export class ApiFailure extends Error {}

/** The API's own error message, with its details if it gave any, as the CLI prints it. */
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

/** Calls the API app in-process. Paths are below `API_PREFIX`, as `apiPaths` gives them. No run ID is sent. */
export function toolApi(api: Hono): ToolApi {
  const call = async (method: string, path: string, body?: unknown): Promise<{ type: string; text: string }> => {
    // The API only answers requests addressed to localhost.
    const headers: Record<string, string> = { host: "127.0.0.1" };
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
  };
}

/** One tool, ready to register. Made with `defineTool`. */
export interface AopTool {
  name: string;
  register(server: McpServer, api: ToolApi): void;
}

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  /** snake_case, with no `aop` prefix: clients add the server's name themselves. */
  name: string;
  /** What the agent reads to decide when and how to use the tool. */
  description: string;
  /** Each argument, with a `.describe()` the agent reads. */
  input: Shape;
  annotations?: ToolAnnotations;
  /** Returns the text the agent sees, or a whole result. Throw `ApiFailure` (as `api` does) to fail. */
  run(args: z.output<z.ZodObject<Shape>>, api: ToolApi): Promise<string | CallToolResult>;
}

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** Makes a tool whose API failures become tool errors carrying the API's message. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): AopTool {
  return {
    name: tool.name,
    register(server, api) {
      const input = z.object(tool.input);
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.input, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
        (async (raw: unknown) => {
          try {
            const result = await tool.run(input.parse(raw), api);
            return typeof result === "string" ? textResult(result) : result;
          } catch (error) {
            if (error instanceof ApiFailure) return textResult(error.message, true);
            throw error;
          }
        }) as never,
      );
    },
  };
}
