import Database from "better-sqlite3";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Db } from "./db.js";
import { ApiError, badRequest, ConfigError } from "./errors.js";
import * as nodes from "./nodes.js";
import { getProject, listProjects, registerProject } from "./projects.js";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

const actor = z.enum(["human", "agent", "system"]);
const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");
const title = nonBlank.refine((s) => [...s].length <= 200, "must be at most 200 characters");

const registerProjectBody = z.strictObject({ repo_path: nonBlank, name: nonBlank.optional() });
const createNodeBody = z.strictObject({
  type: nonBlank,
  title,
  body: z.string().optional(),
  cron: nonBlank.optional(),
  actor: actor.default("human"),
});
const nextBody = z.strictObject({
  outcome: nonBlank,
  actor: actor.default("human"),
  reason: nonBlank.optional(),
});
const moveBody = z.strictObject({
  stage: nonBlank,
  type: nonBlank.optional(),
  cron: nonBlank.optional(),
});
const askBody = z.strictObject({ question: nonBlank });
const answerBody = z.strictObject({ answer: nonBlank });
const failBody = z.strictObject({ actor: actor.default("system"), reason: nonBlank.optional() });
const invalidateBody = z.strictObject({ reason: nonBlank, actor: actor.default("human") });
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

export function createApp(db: Db): Hono {
  const app = new Hono();

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

  app.onError((error, c) => {
    if (error instanceof ApiError) return errorResponse(c, error.status, error.code, error.message, error.details);
    if (error instanceof ConfigError) {
      return errorResponse(c, 422, "config_invalid", "The project's AOP config is invalid", error.problems);
    }
    if (error instanceof Database.SqliteError && error.code.startsWith("SQLITE_CONSTRAINT")) {
      return errorResponse(c, 409, "constraint_violation", error.message);
    }
    console.error(error);
    return errorResponse(c, 500, "internal_error", "Internal server error");
  });

  app.notFound((c) => errorResponse(c, 404, "not_found", "No such route"));

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Projects
  app.get("/api/projects", (c) => c.json(listProjects(db)));
  app.post("/api/projects", async (c) => {
    const body = await readBody(c, registerProjectBody);
    const { project, created } = registerProject(db, body.repo_path, body.name);
    return c.json(project, created ? 201 : 200);
  });

  // Nodes
  app.get("/api/projects/:id/nodes", (c) => {
    const project = getProject(db, c.req.param("id"));
    return c.json(nodes.listNodes(db, project.id));
  });
  app.post("/api/projects/:id/nodes", async (c) => {
    const project = getProject(db, c.req.param("id"));
    const body = await readBody(c, createNodeBody);
    return c.json(nodes.createNode(db, project.id, body), 201);
  });
  app.get("/api/nodes/:id", (c) => c.json(nodes.getNode(db, c.req.param("id"))));

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
  app.post("/api/nodes/:id/edges", async (c) =>
    c.json(nodes.addEdge(db, c.req.param("id"), await readBody(c, edgeBody)), 201),
  );
  app.delete("/api/edges/:id", (c) => c.json(nodes.removeEdge(db, c.req.param("id"), "human")));

  // Events
  app.get("/api/nodes/:id/events", (c) => c.json(nodes.listEvents(db, c.req.param("id"))));

  return app;
}
