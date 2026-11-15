import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

/** One tool, ready to register. Made with `defineTool`. */
export interface AopTool {
  name: string;
  register(server: McpServer, api: ToolApi): void;
}
