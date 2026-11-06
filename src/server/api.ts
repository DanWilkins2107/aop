// Every HTTP route. Validates bodies, calls the module that owns the data, and renders errors.
// After any successful write it notifies the change feed, which is what wakes pages and the orchestrator.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { LogTail } from "../shared/api.js";
import { readableLines } from "./agentOutput.js";
import { ChangeFeed, EVERYTHING, nodesNotice, type ChangeNotice } from "./changes.js";
import type { Db } from "./db.js";
import { nodeContext } from "./context.js";
import { ApiError, badRequest, ConfigError, notFound, refused } from "./errors.js";
import * as nodes from "./nodes.js";
import { describeConfig, loadConfig } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import { describeProcess } from "./process.js";
import { addProject, deleteProject, getProject, listProjects, updateProject } from "./projects.js";
import { deleteLogs, readLogEnd, readRunLog } from "./runLog.js";
import { getRun, listRuns, projectLogPaths } from "./runs.js";
import { search } from "./search.js";
import { describeStages } from "./stages.js";
import { prepareSteer } from "./steer.js";

const BUILT_WEB_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));
const STREAM_KEEP_ALIVE_MS = 25_000;
/** How much of a run's log the node page shows. */
const TAIL_LINES = 20;
const MAX_TAIL_LINES = 200;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

const actor = z.enum(["human", "agent", "system"]);
const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");
const title = nonBlank.refine((s) => [...s].length <= 200, "must be at most 200 characters");

const repoPath = nonBlank.nullable().optional();
const addProjectBody = z.strictObject({ name: title.optional(), repo_path: repoPath });
const updateProjectBody = z
  .strictObject({ name: title.optional(), repo_path: repoPath })
  .refine((edit) => edit.name !== undefined || edit.repo_path !== undefined, "must include name or repo_path");
const createNodeBody = z.strictObject({
  type: nonBlank.optional(),
  stage: nonBlank.optional(),
  title,
  body: z.string().optional(),
  cron: nonBlank.optional(),
  parent_id: nonBlank.optional(),
  actor: actor.default("human"),
});
const editNodeBody = z
  .strictObject({ title: title.optional(), body: z.string().optional(), actor: actor.default("human") })
  .refine((edit) => edit.title !== undefined || edit.body !== undefined, "must include title or body");
const nextBody = z.strictObject({ outcome: nonBlank, actor: actor.default("human") });
const moveBody = z.strictObject({
  stage: nonBlank,
  type: nonBlank.optional(),
  cron: nonBlank.optional(),
});
const askBody = z.strictObject({ question: nonBlank });
const answerBody = z.strictObject({ answer: nonBlank });
const failBody = z.strictObject({ actor: actor.default("system"), reason: nonBlank.optional() });
const invalidateBody = z.strictObject({ reason: nonBlank, actor: actor.default("human") });
const actorBody = z.strictObject({ actor: actor.default("human") });
const steerBody = z.strictObject({ no_sandbox: z.boolean().default(false) });
const blockBody = z.strictObject({ reason: nonBlank, actor: actor.default("human") });
const unblockBody = z.strictObject({ actor: actor.default("human") });
const claimBody = z.strictObject({ actor: z.enum(["human", "agent"]).default("human") });
const messageBody = z.strictObject({ body: nonBlank, author: actor.default("human") });
const linkBody = z.strictObject({
  kind: z.enum(["ticket", "pr"]),
  url: z.string().regex(/^https?:\/\/\S+$/, "must start with http:// or https://"),
  actor: actor.default("human"),
});
const edgeBody = z.strictObject({
  target_id: nonBlank,
  kind: z.enum(["subtask", "blocks"]),
  actor: actor.default("human"),
});

async function readBody<S extends z.ZodType>(c: Context, schema: S, emptyAllowed = false): Promise<z.output<S>> {
  const text = await c.req.text();
  let json: unknown = {};
  if (text.trim() !== "" || !emptyAllowed) {
    try {
      json = JSON.parse(text);
    } catch {
      throw badRequest("The request body must be JSON");
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw badRequest(
      "Invalid request body",
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data;
}

function errorResponse(c: Context, status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
}

/** The Origins of pages this server could have served, given the Host it was reached on. */
function ownOrigins(host: string): string[] {
  const port = host.split(":")[1];
  const suffix = port ? `:${port}` : "";
  return [`http://localhost${suffix}`, `http://127.0.0.1${suffix}`];
}

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

/** Serves the built app. Any other path gets `index.html`, because the routes live in the browser. */
function serveWeb(app: Hono, dir: string): void {
  const files = serveStatic({ root: dir });
  const page = serveStatic({ path: join(dir, "index.html") });
  app.use("*", (c, proceed) => (isApiPath(c.req.path) ? proceed() : files(c, proceed)));
  app.use("*", (c, proceed) => (isApiPath(c.req.path) ? proceed() : page(c, proceed)));
}

export interface AppOptions {
  changes?: ChangeFeed;
  /** The built web app. Skipped if the folder doesn't exist, so the API runs without a build. */
  webDir?: string;
  /** Runs agents. The demo has none, so the routes that need it refuse there. */
  orchestrator?: Orchestrator;
}

export function createApp(db: Db, options: AppOptions = {}): Hono {
  const app = new Hono();
  const changes = options.changes ?? new ChangeFeed();
  const webDir = options.webDir ?? BUILT_WEB_DIR;
  const orchestrator = (): Orchestrator => {
    if (!options.orchestrator) throw refused("This server doesn't run agents");
    return options.orchestrator;
  };

  // Keeps other websites out, including through DNS rebinding. Non-browser clients send no Origin.
  app.use("*", async (c, proceed) => {
    const host = c.req.header("host");
    if (!host || !LOCAL_HOST.test(host)) {
      return errorResponse(c, 403, "forbidden_host", "Host must be localhost or 127.0.0.1");
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !ownOrigins(host).includes(origin.toLowerCase())) {
      return errorResponse(c, 403, "forbidden_origin", "Cross-origin requests are not allowed");
    }
    await proceed();
    return;
  });

  /** What each write touched, which its route records for the change notice. None recorded means anything. */
  const touched = new WeakMap<Request, ChangeNotice>();
  const isWrite = (c: Context) => !["GET", "HEAD"].includes(c.req.method) && c.res.status < 400;

  // Every write comes through here, and refused ones change nothing.
  app.use("/api/*", async (c, proceed) => {
    await proceed();
    if (isWrite(c)) changes.notify(touched.get(c.req.raw) ?? EVERYTHING);
  });

  const touchedNodes = (...nodeIds: string[]): ChangeNotice => nodesNotice(db, ...nodeIds);
  /** A project's own row: its nodes' messages, events, links and edges are untouched unless `nodeIds` says. */
  const touchedProject = (projectId: string, nodeIds: string[] | null = []): ChangeNotice => ({
    project_ids: [projectId],
    node_ids: nodeIds,
  });

  // A write to a node touches that node, unless its route recorded more.
  const nodeWrite = async (c: Context, proceed: () => Promise<void>) => {
    await proceed();
    if (isWrite(c) && !touched.has(c.req.raw)) touched.set(c.req.raw, touchedNodes(c.req.param("id") ?? ""));
  };
  app.use("/api/nodes/:id", nodeWrite);
  app.use("/api/nodes/:id/*", nodeWrite);

  app.onError((error, c) => {
    if (error instanceof ApiError) return errorResponse(c, error.status, error.code, error.message, error.details);
    if (error instanceof ConfigError) {
      return errorResponse(c, 422, "config_invalid", "The AOP config is invalid", error.problems);
    }
    if (error instanceof Database.SqliteError && error.code.startsWith("SQLITE_CONSTRAINT")) {
      return errorResponse(c, 409, "constraint_violation", error.message);
    }
    console.error(error);
    return errorResponse(c, 500, "internal_error", "Internal server error");
  });

  app.notFound((c) => errorResponse(c, 404, "not_found", "No such route"));

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Fires once per burst of changes, saying where. `ready` lets a client catch up on anything missed while away.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      await new Promise<void>((finished) => {
        const unsubscribe = changes.subscribeBursts(
          (notice) => void stream.writeSSE({ event: "change", data: JSON.stringify(notice) }),
        );
        const keepAlive = setInterval(() => void stream.write(": keep-alive\n\n"), STREAM_KEEP_ALIVE_MS);
        stream.onAbort(() => {
          unsubscribe();
          clearInterval(keepAlive);
          finished();
        });
        void stream.writeSSE({ event: "ready", data: "{}" });
      });
    }),
  );

  // Projects
  app.get("/api/projects", (c) => c.json(listProjects(db)));
  app.post("/api/projects", async (c) => {
    const project = addProject(db, await readBody(c, addProjectBody));
    touched.set(c.req.raw, touchedProject(project.id));
    return c.json(project, 201);
  });
  app.patch("/api/projects/:id", async (c) => {
    const project = updateProject(db, c.req.param("id"), await readBody(c, updateProjectBody));
    touched.set(c.req.raw, touchedProject(project.id));
    return c.json(project);
  });
  app.delete("/api/projects/:id", async (c) => {
    const { id } = getProject(db, c.req.param("id"));
    // Agents stop first, and none can start on the project until it has gone.
    const reopen = await options.orchestrator?.stopProjectAgents(id);
    let deleted: ReturnType<typeof deleteProject>;
    let logs: string[];
    try {
      logs = projectLogPaths(db, id);
      deleted = deleteProject(db, id);
    } finally {
      reopen?.();
    }
    // Only once the project has gone, and its agents have stopped and closed their logs.
    deleteLogs(logs);
    touched.set(c.req.raw, touchedProject(id, null));
    return c.json(deleted);
  });

  // The one process, shared by all projects. Read from disk every time.
  app.get("/api/stages", (c) => c.json(describeStages(loadConfig().graph)));
  // For the process page, which still answers when the config is invalid, listing the problems.
  app.get("/api/process", (c) => c.json(describeProcess()));

  // Read-only on purpose. Agents can reach this API, so no route may change commands.
  app.get("/api/config", (c) => c.json(describeConfig()));

  app.get("/api/projects/:id/edges", (c) => {
    const project = getProject(db, c.req.param("id"));
    return c.json(nodes.listProjectEdges(db, project.id));
  });

  // Nodes
  app.get("/api/projects/:id/nodes", (c) => {
    const project = getProject(db, c.req.param("id"));
    return c.json(nodes.listNodes(db, project.id));
  });
  app.post("/api/projects/:id/nodes", async (c) => {
    const project = getProject(db, c.req.param("id"));
    const body = await readBody(c, createNodeBody);
    const node = nodes.createNode(db, project.id, body);
    // A parent gets an edge, and an event saying so.
    touched.set(c.req.raw, touchedNodes(node.id, ...(body.parent_id === undefined ? [] : [body.parent_id])));
    return c.json(node, 201);
  });
  app.get("/api/nodes/:id", (c) => c.json(nodes.getNode(db, c.req.param("id"))));
  app.patch("/api/nodes/:id", async (c) =>
    c.json(nodes.editNode(db, c.req.param("id"), await readBody(c, editNodeBody))),
  );

  app.get("/api/nodes/:id/context", (c) => c.text(nodeContext(db, c.req.param("id"))));
  app.post("/api/nodes/:id/steer", async (c) =>
    c.json(prepareSteer(db, c.req.param("id"), await readBody(c, steerBody, true))),
  );

  // Stage changes
  app.post("/api/nodes/:id/next", async (c) =>
    c.json(nodes.next(db, c.req.param("id"), await readBody(c, nextBody))),
  );
  app.post("/api/nodes/:id/move", async (c) =>
    c.json(nodes.move(db, c.req.param("id"), await readBody(c, moveBody))),
  );
  app.post("/api/nodes/:id/ask", async (c) =>
    c.json(nodes.ask(db, c.req.param("id"), await readBody(c, askBody))),
  );
  app.post("/api/nodes/:id/answer", async (c) =>
    c.json(nodes.answer(db, c.req.param("id"), await readBody(c, answerBody))),
  );
  app.post("/api/nodes/:id/fail", async (c) =>
    c.json(nodes.fail(db, c.req.param("id"), await readBody(c, failBody, true))),
  );
  app.post("/api/nodes/:id/retry", (c) => c.json(nodes.retry(db, c.req.param("id"))));
  app.post("/api/nodes/:id/invalidate", async (c) =>
    c.json(nodes.invalidate(db, c.req.param("id"), await readBody(c, invalidateBody))),
  );
  app.post("/api/nodes/:id/restore", (c) => c.json(nodes.restore(db, c.req.param("id"))));

  app.post("/api/nodes/:id/block", async (c) =>
    c.json(nodes.block(db, c.req.param("id"), await readBody(c, blockBody))),
  );
  app.post("/api/nodes/:id/unblock", async (c) =>
    c.json(nodes.unblock(db, c.req.param("id"), await readBody(c, unblockBody, true))),
  );
  app.post("/api/nodes/:id/split/start", (c) => c.json(nodes.splitStart(db, c.req.param("id"))));
  app.post("/api/nodes/:id/split/finish", (c) => c.json(nodes.splitFinish(db, c.req.param("id"))));

  // Claims
  app.post("/api/nodes/:id/claim", async (c) =>
    c.json(nodes.claim(db, c.req.param("id"), await readBody(c, claimBody, true))),
  );
  app.post("/api/nodes/:id/release", async (c) =>
    c.json(nodes.releaseClaim(db, c.req.param("id"), await readBody(c, claimBody, true))),
  );

  // Messages
  app.get("/api/nodes/:id/messages", (c) => c.json(nodes.listMessages(db, c.req.param("id"))));
  app.post("/api/nodes/:id/messages", async (c) =>
    c.json(nodes.addMessage(db, c.req.param("id"), await readBody(c, messageBody)), 201),
  );

  // Links
  app.get("/api/nodes/:id/links", (c) => c.json(nodes.listLinks(db, c.req.param("id"))));
  app.post("/api/nodes/:id/links", async (c) =>
    c.json(nodes.addLink(db, c.req.param("id"), await readBody(c, linkBody)), 201),
  );

  // Edges
  app.get("/api/nodes/:id/edges", (c) =>
    c.json(nodes.listEdges(db, c.req.param("id"), c.req.query("include_removed") === "true")),
  );
  app.post("/api/nodes/:id/edges", async (c) => {
    const edge = nodes.addEdge(db, c.req.param("id"), await readBody(c, edgeBody));
    touched.set(c.req.raw, touchedNodes(edge.source_id, edge.target_id));
    return c.json(edge, 201);
  });
  app.delete("/api/edges/:id", async (c) => {
    const edge = nodes.removeEdge(db, c.req.param("id"), (await readBody(c, actorBody, true)).actor);
    touched.set(c.req.raw, touchedNodes(edge.source_id, edge.target_id));
    return c.json(edge);
  });

  // Events
  app.get("/api/nodes/:id/events", (c) => c.json(nodes.listEvents(db, c.req.param("id"))));

  // Search
  app.get("/api/search", (c) => {
    const query = c.req.query("q");
    if (query === undefined || query.trim() === "") throw badRequest("Search needs a query, in q");
    const project = c.req.query("project");
    return c.json(search(db, query, project === undefined ? null : getProject(db, project).id));
  });

  // Agents
  app.get("/api/agents", async (c) => c.json(await orchestrator().listAgents()));
  app.post("/api/agents/reap", async (c) => c.json(await orchestrator().reap()));
  app.post("/api/runs/:id/stop", async (c) => {
    const node = await orchestrator().stopRun(c.req.param("id"));
    touched.set(c.req.raw, touchedNodes(node.id));
    return c.json(node);
  });
  app.get("/api/nodes/:id/runs", (c) => {
    const node = nodes.getNodeRow(db, c.req.param("id"));
    return c.json(listRuns(db, node.id));
  });
  app.get("/api/runs/:id/log", (c) => {
    const run = getRun(db, c.req.param("id"));
    if (!run) throw notFound(`No run ${c.req.param("id")}`);
    const log = readRunLog(run.log_path);
    if (log === null) throw notFound(`The log for run ${run.id} is gone`);
    // Text, and marked as such: what an agent printed must never run as a page on this origin.
    c.header("X-Content-Type-Options", "nosniff");
    return c.text(log);
  });
  app.get("/api/runs/:id/tail", (c) => {
    const run = getRun(db, c.req.param("id"));
    if (!run) throw notFound(`No run ${c.req.param("id")}`);
    const count = c.req.query("lines") === undefined ? TAIL_LINES : Number(c.req.query("lines"));
    if (!Number.isInteger(count) || count < 1 || count > MAX_TAIL_LINES) {
      throw badRequest(`lines must be a whole number from 1 to ${MAX_TAIL_LINES}`);
    }
    const raw = readLogEnd(run.log_path);
    if (raw === null) throw notFound(`The log for run ${run.id} is gone`);
    const tail: LogTail = { run_id: run.id, running: run.status === "running", lines: readableLines(raw, run.output_format).slice(-count) };
    return c.json(tail);
  });

  if (existsSync(webDir)) serveWeb(app, webDir);

  return app;
}
