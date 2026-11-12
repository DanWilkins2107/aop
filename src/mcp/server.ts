// The agents' MCP server: how agents read and change the board, as tools served at `/mcp` on its own
// localhost port, so a sandboxed agent can be given that port and nothing else. Stateless: no
// sessions or tokens. Every tool that acts on a node names it, and every write names its run.

import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { type AppOptions, createApp } from "../server/api.js";
import type { Db } from "../server/db.js";
import { HOSTNAME, type RunningServer } from "../server/server.js";
import { toolApi } from "./shared/toolApi.js";
import { TOOLS } from "./tools/registry.js";

export const MCP_PATH = "/mcp";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/** The MCP endpoint over an API app, which every tool calls in-process. */
export function createMcpApp(api: Hono): Hono {
  const calls = toolApi(api);
  const app = new Hono();

  // Keeps websites out, including through DNS rebinding. Non-browser clients send no Origin.
  app.use("*", async (c, proceed) => {
    const host = c.req.header("host");
    if (!host || !LOCAL_HOST.test(host)) return c.json({ error: "Host must be localhost or 127.0.0.1" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return c.json({ error: "Cross-origin requests are not allowed" }, 403);
    await proceed();
    return;
  });

  app.all(MCP_PATH, async (c) => {
    // A server and transport per request is the SDK's stateless pattern: no request can see another's
    // replies, however many agents share the port. Registering the tools is cheap.
    const server = new McpServer({ name: "aop", version: "1.0.0" });
    for (const tool of TOOLS) tool.register(server, calls);
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c);
  });

  return app;
}

/** Serves the MCP endpoint on localhost only, over its own copy of the API app. Pass port 0 for any free port. */
export function startMcpServer(db: Db, port: number, options: AppOptions = {}): Promise<RunningServer> {
  const app = createMcpApp(createApp(db, options));
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port }, (info) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((e) => (e ? fail(e) : done()));
            server.closeAllConnections();
          }),
      });
    }) as Server;
    server.once("error", reject);
  });
}
