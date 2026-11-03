import { request } from "node:http";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/server/db.js";
import { HOSTNAME, startServer, type RunningServer } from "../../src/server/server.js";
import { makeHome, makeRepo } from "./helpers.js";

let db: Db;
let server: RunningServer;
let home: string;
let outerHome: string | undefined;

beforeAll(async () => {
  home = makeHome();
  outerHome = process.env["AOP_HOME"];
  process.env["AOP_HOME"] = home;
  db = openDb();
  server = await startServer(db, 0);
});

afterAll(async () => {
  await server.close();
  db.close();
  process.env["AOP_HOME"] = outerHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** node:http rather than fetch, so that Host and Origin can be set to anything. */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
  address = "127.0.0.1",
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port: server.port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("localhost only", () => {
  const own = () => ({ host: `127.0.0.1:${server.port}` });

  it("binds to 127.0.0.1", () => {
    expect(HOSTNAME).toBe("127.0.0.1");
  });

  it("isn't reachable on IPv6 loopback", async () => {
    await expect(send("GET", "/api/health", own(), undefined, "::1")).rejects.toThrow();
  });

  it("accepts localhost and 127.0.0.1 as Host", async () => {
    expect((await send("GET", "/api/health", own())).status).toBe(200);
    expect((await send("GET", "/api/health", { host: `localhost:${server.port}` })).status).toBe(200);
    expect((await send("GET", "/api/health", { host: `LOCALHOST:${server.port}` })).status).toBe(200);
  });

  it("rejects any other Host, which is how DNS rebinding would arrive", async () => {
    for (const host of ["evil.example", `evil.example:${server.port}`, "localhost.evil.example", "127.0.0.1.evil.example", "0.0.0.0"]) {
      const res = await send("GET", "/api/health", { host });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ error: { code: "forbidden_host" } });
    }
  });

  it("accepts the server's own Origin", async () => {
    for (const origin of [`http://localhost:${server.port}`, `http://127.0.0.1:${server.port}`]) {
      expect((await send("GET", "/api/health", { ...own(), origin })).status).toBe(200);
    }
  });

  it("rejects any other Origin, including other local ports", async () => {
    for (const origin of [
      "https://evil.example",
      "http://evil.example",
      "null",
      "http://localhost",
      `http://localhost:${server.port + 1}`,
      `https://localhost:${server.port}`,
      `http://localhost:${server.port}.evil.example`,
    ]) {
      const res = await send("GET", "/api/health", { ...own(), origin });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ error: { code: "forbidden_origin" } });
    }
  });

  it("rejects a cross-site write before it does anything", async () => {
    const res = await send(
      "POST",
      "/api/projects",
      { ...own(), origin: "https://evil.example", "content-type": "text/plain" },
      { repo_path: makeRepo() },
    );
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });
});

describe("over real HTTP", () => {
  it("creates a node and moves it", async () => {
    const headers = { host: `127.0.0.1:${server.port}` };
    const project = await send("POST", "/api/projects", headers, { repo_path: makeRepo() });
    expect(project.status).toBe(201);
    const node = await send("POST", `/api/projects/${String(project.json["id"])}/nodes`, headers, {
      type: "triage",
      title: "Over the wire",
    });
    expect(node.json).toMatchObject({ stage: "assess" });
    const moved = await send("POST", `/api/nodes/${String(node.json["id"])}/next`, headers, { outcome: "ready" });
    expect(moved.json).toMatchObject({ type: "dev", stage: "write_spec" });
  });
});
