import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type ClientRequest } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api.js";
import { ChangeFeed } from "../../src/server/changes.js";
import { openDb, type Db } from "../../src/server/db.js";
import { aopHome } from "../../src/server/paths.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import type { EventView } from "../../src/shared/events/types.js";
import type { EdgeRow, NodeView } from "../../src/shared/nodes/types.js";
import type { StagesView } from "../../src/shared/stages/types.js";
import { harness, makeHome, makeRepo, STAGES_YAML, type Harness } from "./helpers.js";

describe("UI API", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("describes the shared stages in file order, without prompt paths", async () => {
    const res = await h.call<StagesView>("GET", "/api/stages");
    expect(res.status).toBe(200);
    expect(res.body.stages[0]).toEqual({ name: "awaiting_agent_breakdown", turn: "agent", color: "#5c7cfa" });
    expect(res.body.types.map((t) => t.name)).toEqual(["triage", "dev", "hotfix", "nightly"]);
    const triage = res.body.types[0];
    expect(triage?.start).toBe("awaiting_agent_breakdown");
    expect(triage?.stages[0]?.next).toContainEqual({ outcome: "split", target: "split_proposed" });
    expect(JSON.stringify(res.body)).not.toContain("prompts");
  });

  it("returns null for a stage with no colour", async () => {
    h.rewriteStages(STAGES_YAML.replace('spec_review: { turn: human, color: "#cddc39" }', "spec_review: { turn: human }"));
    const res = await h.call<StagesView>("GET", "/api/stages");
    expect(res.body.stages.find((s) => s.name === "spec_review")?.color).toBeNull();
  });

  it("lists every problem when stages.yaml goes bad", async () => {
    h.rewriteStages("stages: { a: { turn: agent }, b: { turn: agent } }\ntypes: {}\n");
    const res = await h.call<{ error: { code: string; details: string[] } }>("GET", "/api/stages");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("config_invalid");
    expect(res.body.error.details).toHaveLength(3);
  });

  it("404s per-project stages, and the edges of an unknown project", async () => {
    expect((await h.call("GET", `/api/projects/${h.projectId}/stages`)).status).toBe(404);
    expect((await h.call("GET", "/api/projects/nope/edges")).status).toBe(404);
  });

  it("lists a project's active edges, and only that project's", async () => {
    const [a, b, c] = [await h.create("dev"), await h.create("dev"), await h.create("dev")];
    const kept = await h.call<EdgeRow>("POST", `/api/nodes/${a.id}/edges`, { target_id: b.id, kind: "subtask" });
    const gone = await h.call<EdgeRow>("POST", `/api/nodes/${b.id}/edges`, { target_id: c.id, kind: "blocks" });
    await h.call("DELETE", `/api/edges/${gone.body.id}`);

    const other = await h.call<{ id: string }>("POST", "/api/projects", { repo_path: makeRepo() });
    const res = await h.call<EdgeRow[]>("GET", `/api/projects/${h.projectId}/edges`);
    expect(res.body.map((e) => e.id)).toEqual([kept.body.id]);
    expect((await h.call<EdgeRow[]>("GET", `/api/projects/${other.body.id}/edges`)).body).toEqual([]);
  });

  describe("editing a description", () => {
    it("saves it and keeps the old text in the event", async () => {
      const node = await h.create("dev", { body: "old" });
      const res = await h.call<NodeView>("PATCH", `/api/nodes/${node.id}`, { body: "new" });
      expect(res.status).toBe(200);
      expect(res.body.body).toBe("new");
      const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
      expect(events.body.find((e) => e.kind === "description_edited")?.data).toEqual({ previous: "old" });
    });

    it("can clear it", async () => {
      const node = await h.create("dev", { body: "old" });
      expect((await h.call<NodeView>("PATCH", `/api/nodes/${node.id}`, { body: "" })).body.body).toBe("");
    });

    it("logs nothing when the text is unchanged", async () => {
      const node = await h.create("dev", { body: "same" });
      await h.call("PATCH", `/api/nodes/${node.id}`, { body: "same" });
      const events = await h.call<EventView[]>("GET", `/api/nodes/${node.id}/events`);
      expect(events.body.some((e) => e.kind === "description_edited")).toBe(false);
    });

    it("refuses other fields and unknown nodes", async () => {
      const node = await h.create("dev");
      expect((await h.call("PATCH", `/api/nodes/${node.id}`, { stage: "done" })).status).toBe(400);
      expect((await h.call("PATCH", "/api/nodes/nope", { body: "x" })).status).toBe(404);
    });
  });
});

describe("change events", () => {
  let db: Db;
  let home: string;
  let server: RunningServer;
  let projectId: string;
  const changes = new ChangeFeed();
  const open: ClientRequest[] = [];
  let outerHome: string | undefined;

  beforeAll(async () => {
    home = makeHome();
    outerHome = process.env["AOP_HOME"];
    process.env["AOP_HOME"] = home;
    db = openDb();
    server = await startServer(db, 0, { changes });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
      method: "POST",
      body: JSON.stringify({ repo_path: makeRepo() }),
    });
    projectId = ((await res.json()) as { id: string }).id;
  });

  afterEach(async () => {
    for (const req of open.splice(0)) req.destroy();
    await expect.poll(() => changes.size).toBe(0);
  });

  afterAll(async () => {
    await server.close();
    db.close();
    process.env["AOP_HOME"] = outerHome;
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  interface Stream {
    status: number;
    /** Resolves once this many `event:` lines have arrived. */
    events(count: number): Promise<string[]>;
    /** The data of every `change` event so far. */
    notices(): unknown[];
    close(): void;
  }

  function connect(headers: Record<string, string> = {}): Promise<Stream> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path: "/api/events", headers: { host: `127.0.0.1:${server.port}`, ...headers } },
        (res) => {
          let text = "";
          const waiters: (() => void)[] = [];
          const names = () => [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1] ?? "");
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
            for (const wake of waiters.splice(0)) wake();
          });
          resolve({
            status: res.statusCode ?? 0,
            close: () => req.destroy(),
            notices: () =>
              [...text.matchAll(/^event: change\r?\ndata: (.*)$/gm)].map((m) => JSON.parse(m[1] ?? "null") as unknown),
            events: async (count) => {
              while (names().length < count) await new Promise<void>((wake) => waiters.push(wake));
              return names();
            },
          });
        },
      );
      req.on("error", (error) => {
        if (!req.destroyed) reject(error);
      });
      req.end();
      open.push(req);
    });
  }

  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", body: JSON.stringify(body) });

  it("says ready on connecting, then fires when data changes", async () => {
    const stream = await connect();
    expect(stream.status).toBe(200);
    expect(await stream.events(1)).toEqual(["ready"]);
    expect((await post(`/projects/${projectId}/nodes`, { type: "dev", title: "T" })).status).toBe(201);
    expect(await stream.events(2)).toEqual(["ready", "change"]);
  });

  it("stays quiet for reads and refused writes", async () => {
    const stream = await connect();
    await stream.events(1);
    await fetch(`http://127.0.0.1:${server.port}/api/projects`);
    expect((await post(`/projects/${projectId}/nodes`, { type: "nope", title: "T" })).status).toBe(400);
    // The next real change must be the first one the stream sees.
    await post(`/projects/${projectId}/nodes`, { type: "dev", title: "T" });
    expect(await stream.events(2)).toEqual(["ready", "change"]);
  });

  it("says which project and nodes changed, once for a burst of writes", async () => {
    const stream = await connect();
    await stream.events(1);
    const [first, second] = (await Promise.all([
      post(`/projects/${projectId}/nodes`, { type: "dev", title: "One" }).then((res) => res.json()),
      post(`/projects/${projectId}/nodes`, { type: "dev", title: "Two" }).then((res) => res.json()),
    ])) as NodeView[];
    expect(await stream.events(2)).toEqual(["ready", "change"]);
    const [notice] = stream.notices() as { project_ids: string[]; node_ids: string[] }[];
    expect(notice?.project_ids).toEqual([projectId]);
    expect([...(notice?.node_ids ?? [])].sort()).toEqual([first!.id, second!.id].sort());

    // A later write is a new burst. An edge changes both ends' own data.
    await new Promise((wait) => setTimeout(wait, 100));
    expect((await post(`/nodes/${first!.id}/edges`, { target_id: second!.id, kind: "blocks" })).status).toBe(201);
    expect(await stream.events(3)).toEqual(["ready", "change", "change"]);
    expect(stream.notices()[1]).toEqual({ project_ids: [projectId], node_ids: [first!.id, second!.id] });
  });

  it("stops listening when the client goes away", async () => {
    const stream = await connect();
    await stream.events(1);
    expect(changes.size).toBe(1);
    stream.close();
    await expect.poll(() => changes.size).toBe(0);
  });

  it("refuses a foreign Host and a foreign Origin", async () => {
    const wrongHost = await connect({ host: "evil.example" });
    const wrongOrigin = await connect({ origin: "http://evil.example" });
    expect(wrongHost.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
    expect(changes.size).toBe(0);
  });

  it("lets a server with an open stream shut down", async () => {
    const other = await startServer(db, 0);
    const res = await fetch(`http://127.0.0.1:${other.port}/api/events`);
    expect(res.status).toBe(200);
    await other.close();
    await res.body?.cancel().catch(() => undefined);
  });
});

describe("serving the web app", () => {
  let db: Db;
  let home: string;
  let webDir: string;

  beforeAll(() => {
    home = mkdtempSync(join(aopHome(), "web-"));
    db = openDb(join(home, "aop.db"));
    webDir = join(home, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<title>page</title>");
    writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(home, "secret.txt"), "secret");
  });

  afterAll(() => {
    db.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const get = (path: string, headers: Record<string, string> = { host: "localhost:4317" }) =>
    createApp(db, { webDir }).request(path, { headers });

  it("serves files, and the page for any route the browser owns", async () => {
    expect(await (await get("/assets/app.js")).text()).toBe("console.log(1)");
    for (const path of ["/", "/p/abc", "/p/abc/settings", "/settings", "/n/abc"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("page");
    }
  });

  it("still answers unknown API routes with a JSON 404", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("doesn't serve anything outside its folder", async () => {
    for (const path of ["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt"]) {
      expect(await (await get(path)).text()).not.toContain("secret");
    }
  });

  it("applies the Host and Origin checks to the page too", async () => {
    expect((await get("/", { host: "evil.example" })).status).toBe(403);
    expect((await get("/", { host: "localhost:4317", origin: "http://evil.example" })).status).toBe(403);
  });

  it("runs the API without a build", async () => {
    const res = await createApp(db, { webDir: join(home, "missing") }).request("/", { headers: { host: "localhost" } });
    expect(res.status).toBe(404);
  });
});
