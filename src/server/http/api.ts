// The HTTP app: guards every request, renders errors, and hands each concept's routes the context they
// share. After any successful write it notifies the change feed, which is what wakes pages and the
// orchestrator. The routes are in the `*Routes.ts` files beside this one.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { API_PREFIX } from "../../shared/http/apiPrefix.js";
import type { ApiErrorBody, ApiErrorCode } from "../../shared/http/types.js";
import { withConfigSnapshot } from "../config/config.js";
import { ChangeFeed, EVERYTHING, eventsMark, eventsNotice, mergeNotices, type ChangeNotice } from "../db/changes.js";
import type { Db } from "../db/db.js";
import { openSteerSessionNode } from "../nodes/claims.js";
import type { Orchestrator } from "../runs/orchestrator.js";
import { getRun } from "../runs/runs.js";
import { ApiError, ConfigError, refused } from "../shared/errors.js";
import { improvementRoutes } from "./improvementRoutes.js";
import { nodeRoutes } from "./nodeRoutes.js";
import { projectRoutes } from "./projectRoutes.js";
import { type RouteContext, runIdOf } from "./routeContext.js";
import { at } from "./routes.js";
import { runRoutes } from "./runRoutes.js";
import { stageRoutes } from "./stageRoutes.js";

const BUILT_WEB_DIR = fileURLToPath(new URL("../../../dist/web", import.meta.url));
const STREAM_KEEP_ALIVE_MS = 25_000;
/** Far above any real body (long descriptions and messages included), but caps what one request can hold in memory. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

function errorResponse(c: Context, status: ContentfulStatusCode, code: ApiErrorCode, message: string, details?: unknown) {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return c.json(body, status);
}

/** The Origins of pages this server could have served, given the Host it was reached on. */
function ownOrigins(host: string): string[] {
  const port = host.split(":")[1];
  const suffix = port ? `:${port}` : "";
  return [`http://localhost${suffix}`, `http://127.0.0.1${suffix}`];
}

const isApiPath = (path: string) => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);

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
  /** Runs agents. Without one, the routes that need it refuse. */
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

  // One read of the config for the whole request, however many times its code asks.
  app.use("*", (_c, proceed) => withConfigSnapshot(proceed));

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

  /** What each write touched beyond the nodes its events name, which its route records. */
  const touched = new WeakMap<Request, ChangeNotice>();
  const isRead = (c: Context) => ["GET", "HEAD"].includes(c.req.method);
  const isWrite = (c: Context) => !isRead(c) && c.res.status < 400;
  // Some routes serve what agents and people wrote as text/plain (a node's context, a run's log).
  // Browsers must take the type as given, so none of it can ever run as a page on this origin.
  app.use(`${API_PREFIX}/*`, async (c, proceed) => {
    await proceed();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  // Bodies are read whole, so they are capped before any route reads one.
  app.use(
    `${API_PREFIX}/*`,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        errorResponse(c, 413, "payload_too_large", `The request body must be at most ${MAX_BODY_BYTES / (1024 * 1024)} MB`),
    }),
  );

  // Every write comes through here, and refused ones change nothing.
  app.use(`${API_PREFIX}/*`, async (c, proceed) => {
    // A process left over from an ended run can still call the tools, and must not act on the board.
    // The run ID is a running run's, or an open steered session's, whose claim still holds. Stage
    // changes check it against the node as well, inside their transaction: see `stageMachine.ts`.
    const runId = runIdOf(c);
    if (
      runId !== undefined &&
      !isRead(c) &&
      getRun(db, runId)?.status !== "running" &&
      openSteerSessionNode(db, runId) === undefined
    ) {
      throw refused(`Agent run ${runId} has ended, so it can't change anything. It should exit`);
    }
    // Events other writes append meanwhile count too: a page refetching once more is harmless.
    const mark = isRead(c) ? 0 : eventsMark(db);
    await proceed();
    if (!isWrite(c)) return;
    const notices = [touched.get(c.req.raw), eventsNotice(db, mark)].filter((notice) => notice != null);
    // A write that appended no event and recorded nothing may have changed anything.
    changes.notify(notices.length === 0 ? EVERYTHING : notices.reduce(mergeNotices));
  });

  /** A project's own row: its nodes' messages, events, links and edges are untouched unless `nodeIds` says. */
  const touchedProject = (projectId: string, nodeIds: string[] | null = []): ChangeNotice => ({
    project_ids: [projectId],
    node_ids: nodeIds,
  });

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

  app.get(at(apiPaths.health), (c) => c.json({ ok: true }));

  // Fires once per burst of changes, saying where. `ready` lets a client catch up on anything missed while away.
  app.get(at(apiPaths.events), (c) =>
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

  const context: RouteContext = {
    app,
    db,
    orchestrator,
    maybeOrchestrator: options.orchestrator,
    touch: (c, notice) => touched.set(c.req.raw, notice),
    touchedProject,
  };
  projectRoutes(context);
  stageRoutes(context);
  improvementRoutes(context);
  nodeRoutes(context);
  runRoutes(context);

  if (existsSync(webDir)) serveWeb(app, webDir);

  return app;
}
