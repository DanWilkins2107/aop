import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { onTestFinished } from "vitest";
import { createMcpApp, MCP_PATH } from "../server.js";
import { createApp } from "../../server/api.js";
import { getNodeRow } from "../../server/nodes.js";
import { beginRun } from "../../server/runs.js";
import { harness, type Harness } from "../../../test/server/helpers.js";

export interface McpHarness extends Harness {
  /** Calls a tool through a real MCP client, so its input schema is checked as an agent's call would be. */
  tool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** A tool's text, failing the test if the tool failed. */
  text(name: string, args?: Record<string, unknown>): Promise<string>;
  /** What `tools/list` offers. */
  tools(): Promise<Tool[]>;
  /**
   * Opens a running agent run, as a launch does, and returns its ID for a write tool's `run_id`. On
   * this node, which the run then claims, or else on a new node of its own.
   */
  run(nodeId?: string): Promise<string>;
}

/** The text of a tool result, success or error. */
export const resultText = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");

/**
 * A `harness()`, plus an MCP client talking to the MCP app over the same database, in-process. Call it
 * inside a test or `beforeEach`: it closes itself when the test finishes.
 */
export async function mcpHarness(overrides: Record<string, string> = {}): Promise<McpHarness> {
  const h = harness(overrides);
  const app = createMcpApp(createApp(h.db));
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1${MCP_PATH}`), {
    // No socket: every request goes straight to the app, addressed as a local client's would be.
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1");
      return app.request(String(url), { ...init, headers });
    },
  });
  const client = new Client({ name: "aop-test", version: "0.0.0" });
  await client.connect(transport);
  onTestFinished(() => client.close());

  const tool: McpHarness["tool"] = async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return {
    ...h,
    tool,
    async text(name, args) {
      const result = await tool(name, args);
      if (result.isError) throw new Error(`${name} failed: ${resultText(result)}`);
      return resultText(result);
    },
    async tools() {
      return (await client.listTools()).tools;
    },
    async run(nodeId) {
      const id = nodeId ?? (await h.create("dev")).id;
      return beginRun(h.db, getNodeRow(h.db, id), randomUUID(), "unused.log").id;
    },
  };
}
