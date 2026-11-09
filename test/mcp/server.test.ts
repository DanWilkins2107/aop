import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_PATH, startMcpServer } from "../../src/mcp/server.js";
import type { RunningServer } from "../../src/server/server.js";
import { harness } from "../server/helpers.js";

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

/** A raw POST, because fetch won't send a Host header of our choosing. */
function post(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: MCP_PATH,
        method: "POST",
        headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once("error", reject);
    req.end(INITIALIZE);
  });
}

describe("startMcpServer", () => {
  it("serves MCP at /mcp on localhost", async () => {
    const h = harness();
    server = await startMcpServer(h.db, 0);
    const res = await post(server.port, `127.0.0.1:${server.port}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 1, result: { serverInfo: { name: "aop" } } });
  });

  it("refuses a foreign Host header, against DNS rebinding", async () => {
    const h = harness();
    server = await startMcpServer(h.db, 0);
    const res = await post(server.port, `evil.example:${server.port}`);
    expect(res.status).toBe(403);
  });
});
