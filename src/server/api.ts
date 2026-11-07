// Every HTTP route. Validates bodies, calls the module that owns the data, and renders errors.
// After any successful write it notifies the change feed, which is what wakes pages and the orchestrator.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { RUN_ID_HEADER, type ApiErrorBody, type ApiErrorCode, type LogTail } from "../shared/api.js";
import {
  actorBody,
  addProjectBody,
  answerBody,
  applyBody,
  askBody,
  blockBody,
  claimBody,
  createNodeBody,
  edgeBody,
  editNodeBody,
  improvementBody,
  failBody,
  invalidateBody,
  linkBody,
  messageBody,
  moveBody,
  nextBody,
  proposalBody,
  scheduleBody,
  steerBody,
  unblockBody,
  updateProjectBody,
  withdrawBody,
} from "../shared/requests.js";
import { API_PREFIX, apiPaths, routes } from "../shared/paths.js";
import { readableLines } from "./agentOutput.js";
import { ChangeFeed, EVERYTHING, nodesNotice, type ChangeNotice } from "./changes.js";
import type { Db } from "./db.js";
import { nodeContext } from "./context.js";
import { ApiError, badRequest, ConfigError, notFound, refused } from "./errors.js";
import * as nodes from "./nodes.js";
import { describeConfig, loadConfig, withConfigSnapshot } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import { describeProcess } from "./processView.js";
import { addProject, deleteProject, getProject, listProjects, updateProject } from "./projects.js";
import { deleteLogs, readLogEnd, readRunLog } from "./runLog.js";
import { getRun, listRuns, projectLogPaths } from "./runs.js";
import { search } from "./search.js";
import { describeStages, EMPTY_GRAPH } from "./stages.js";
import { applyProposals } from "./applyProposals.js";
import { createImprovement, getImprovement, listImprovements, listProposals, propose, withdraw } from "./improvements.js";
import { prepareSteer } from "./steer.js";

const BUILT_WEB_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));
const STREAM_KEEP_ALIVE_MS = 25_000;
/** How much of a run's log the node page shows. */
const TAIL_LINES = 20;
const MAX_TAIL_LINES = 200;
/** Far above any real body (long descriptions and messages included), but caps what one request can hold in memory. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

/** The route for a path with no parameters. */
const at = <P extends string>(path: P) => `${API_PREFIX}${path}` as const;

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

/** The agent run a request says it comes from. See `RUN_ID_HEADER`. */
function runIdOf(c: Context): string | undefined {
  const value = c.req.header(RUN_ID_HEADER)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

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

  /** What each write touched, which its route records for the change notice. None recorded means anything. */
  const touched = new WeakMap<Request, ChangeNotice>();
  const isWrite = (c: Context) => !["GET", "HEAD"].includes(c.req.method) && c.res.status < 400;
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
    // A process left over from an ended run still has its CLI, and must not act on the board. Stage
    // changes check the run against the node as well, inside their transaction: see `stageMachine.ts`.
    const runId = runIdOf(c);
    if (runId !== undefined && !["GET", "HEAD"].includes(c.req.method) && getRun(db, runId)?.status !== "running") {
      throw refused(`Agent run ${runId} has ended, so it can't change anything. It should exit`);
    }
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
  app.use(routes.node, nodeWrite);
  app.use(`${routes.node}/*`, nodeWrite);

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

  // Projects
  app.get(at(apiPaths.projects), (c) => c.json(listProjects(db)));
  app.post(at(apiPaths.projects), async (c) => {
    const project = addProject(db, await readBody(c, addProjectBody));
    touched.set(c.req.raw, touchedProject(project.id));
    return c.json(project, 201);
  });
  app.patch(routes.project, async (c) => {
    const project = updateProject(db, c.req.param("id"), await readBody(c, updateProjectBody));
    touched.set(c.req.raw, touchedProject(project.id));
    return c.json(project);
  });
  app.delete(routes.project, async (c) => {
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

  // The one process, shared by all projects. Read from disk whenever it has changed.
  app.get(at(apiPaths.stages), (c) => c.json(describeStages(loadConfig().graph)));
  // For the process page, which still answers when the config is invalid, listing the problems.
  app.get(at(apiPaths.process), (c) => c.json(describeProcess()));

  app.get(at(apiPaths.improvementStages), (c) => c.json(describeStages(loadConfig().improvementGraph ?? EMPTY_GRAPH)));

  // Improvements. Proposals are stored here; only apply writes files, and only where allowedTarget says.
  // Each write says what it touched: the improvement, and on capture the work node it came from.
  app.get(at(apiPaths.improvements), (c) => c.json(listImprovements(db)));
  app.post(at(apiPaths.improvements), async (c) => {
    const improvement = createImprovement(db, await readBody(c, improvementBody));
    const source = improvement.source?.node_id;
    touched.set(c.req.raw, touchedNodes(improvement.node.id, ...(source == null ? [] : [source])));
    return c.json(improvement, 201);
  });
  app.get(routes.improvement, (c) => c.json(getImprovement(db, c.req.param("id"))));
  app.get(routes.improvementAction("proposals"), (c) => c.json(listProposals(db, c.req.param("id"))));
  app.put(routes.improvementAction("proposals"), async (c) => {
    const proposal = propose(db, c.req.param("id"), await readBody(c, proposalBody));
    touched.set(c.req.raw, touchedNodes(c.req.param("id")));
    return c.json(proposal);
  });
  app.delete(routes.improvementAction("proposals"), async (c) => {
    const withdrawn = withdraw(db, c.req.param("id"), await readBody(c, withdrawBody));
    touched.set(c.req.raw, touchedNodes(c.req.param("id")));
    return c.json(withdrawn);
  });
  // Applying writes real files, which can include stage prompts, and so whether the config is valid:
  // it records nothing narrower, so every page refetches.
  app.post(routes.improvementAction("apply"), async (c) =>
    c.json(applyProposals(db, c.req.param("id"), await readBody(c, applyBody, true))),
  );

  // Read-only on purpose. Agents can reach this API, so no route may change commands.
  app.get(at(apiPaths.config), (c) => c.json(describeConfig()));

  app.get(routes.projectAction("edges"), (c) => {
    const project = getProject(db, c.req.param("id"));
    return c.json(nodes.listProjectEdges(db, project.id));
  });

  // Nodes
  app.get(routes.projectAction("nodes"), (c) => {
    const project = getProject(db, c.req.param("id"));
    return c.json(nodes.listNodes(db, project.id));
  });
  app.post(routes.projectAction("nodes"), async (c) => {
    const project = getProject(db, c.req.param("id"));
    const body = await readBody(c, createNodeBody);
    const node = nodes.createNode(db, project.id, body);
    // A parent gets an edge, and an event saying so.
    touched.set(c.req.raw, touchedNodes(node.id, ...(body.parent_id === undefined ? [] : [body.parent_id])));
    return c.json(node, 201);
  });
  app.get(routes.node, (c) => c.json(nodes.getNode(db, c.req.param("id"))));
  app.patch(routes.node, async (c) =>
    c.json(nodes.editNode(db, c.req.param("id"), await readBody(c, editNodeBody))),
  );

  app.get(routes.nodeAction("context"), (c) => c.text(nodeContext(db, c.req.param("id"))));
  app.post(routes.nodeAction("steer"), async (c) =>
    c.json(prepareSteer(db, c.req.param("id"), await readBody(c, steerBody, true))),
  );

  // Stage changes
  app.post(routes.nodeAction("next"), async (c) =>
    c.json(nodes.next(db, c.req.param("id"), { ...(await readBody(c, nextBody)), runId: runIdOf(c) })),
  );
  app.post(routes.nodeAction("move"), async (c) =>
    c.json(nodes.move(db, c.req.param("id"), await readBody(c, moveBody))),
  );
  app.put(routes.nodeAction("schedule"), async (c) =>
    c.json(nodes.setSchedule(db, c.req.param("id"), await readBody(c, scheduleBody))),
  );
  app.post(routes.nodeAction("ask"), async (c) =>
    c.json(nodes.ask(db, c.req.param("id"), { ...(await readBody(c, askBody)), runId: runIdOf(c) })),
  );
  app.post(routes.nodeAction("answer"), async (c) =>
    c.json(nodes.answer(db, c.req.param("id"), await readBody(c, answerBody))),
  );
  app.post(routes.nodeAction("fail"), async (c) =>
    c.json(nodes.fail(db, c.req.param("id"), { ...(await readBody(c, failBody, true)), runId: runIdOf(c) })),
  );
  app.post(routes.nodeAction("retry"), (c) => c.json(nodes.retry(db, c.req.param("id"))));
  app.post(routes.nodeAction("invalidate"), async (c) =>
    c.json(nodes.invalidate(db, c.req.param("id"), await readBody(c, invalidateBody))),
  );
  app.post(routes.nodeAction("restore"), (c) => c.json(nodes.restore(db, c.req.param("id"))));

  app.post(routes.nodeAction("block"), async (c) =>
    c.json(nodes.block(db, c.req.param("id"), await readBody(c, blockBody))),
  );
  app.post(routes.nodeAction("unblock"), async (c) =>
    c.json(nodes.unblock(db, c.req.param("id"), await readBody(c, unblockBody, true))),
  );
  app.post(routes.nodeAction("split/start"), (c) => c.json(nodes.splitStart(db, c.req.param("id"), { runId: runIdOf(c) })));
  app.post(routes.nodeAction("split/finish"), (c) => c.json(nodes.splitFinish(db, c.req.param("id"), { runId: runIdOf(c) })));

  // Claims
  app.post(routes.nodeAction("claim"), async (c) =>
    c.json(nodes.claim(db, c.req.param("id"), await readBody(c, claimBody, true))),
  );
  app.post(routes.nodeAction("release"), async (c) =>
    c.json(nodes.releaseClaim(db, c.req.param("id"), await readBody(c, claimBody, true))),
  );

  // Messages
  app.get(routes.nodeAction("messages"), (c) => c.json(nodes.listMessages(db, c.req.param("id"))));
  app.post(routes.nodeAction("messages"), async (c) =>
    c.json(nodes.addMessage(db, c.req.param("id"), await readBody(c, messageBody)), 201),
  );

  // Links
  app.get(routes.nodeAction("links"), (c) => c.json(nodes.listLinks(db, c.req.param("id"))));
  app.post(routes.nodeAction("links"), async (c) =>
    c.json(nodes.addLink(db, c.req.param("id"), await readBody(c, linkBody)), 201),
  );

  // Edges
  app.get(routes.nodeAction("edges"), (c) =>
    c.json(nodes.listEdges(db, c.req.param("id"), c.req.query("include_removed") === "true")),
  );
  app.post(routes.nodeAction("edges"), async (c) => {
    const edge = nodes.addEdge(db, c.req.param("id"), await readBody(c, edgeBody));
    touched.set(c.req.raw, touchedNodes(edge.source_id, edge.target_id));
    return c.json(edge, 201);
  });
  app.delete(routes.edge, async (c) => {
    const edge = nodes.removeEdge(db, c.req.param("id"), (await readBody(c, actorBody, true)).actor);
    touched.set(c.req.raw, touchedNodes(edge.source_id, edge.target_id));
    return c.json(edge);
  });

  // Events
  app.get(routes.nodeAction("events"), (c) => c.json(nodes.listEvents(db, c.req.param("id"))));

  // Search
  app.get(at(apiPaths.search), (c) => {
    const query = c.req.query("q");
    if (query === undefined || query.trim() === "") throw badRequest("Search needs a query, in q");
    const project = c.req.query("project");
    return c.json(search(db, query, project === undefined ? null : getProject(db, project).id));
  });

  // Agents
  app.get(at(apiPaths.agents), async (c) => c.json(await orchestrator().listAgents()));
  app.post(at(apiPaths.reap), async (c) => c.json(await orchestrator().reap()));
  app.post(routes.run("stop"), async (c) => {
    const node = await orchestrator().stopRun(c.req.param("id"));
    touched.set(c.req.raw, touchedNodes(node.id));
    return c.json(node);
  });
  app.get(routes.nodeAction("runs"), (c) => {
    const node = nodes.getNodeRow(db, c.req.param("id"));
    return c.json(listRuns(db, node.id));
  });
  app.get(routes.run("log"), (c) => {
    const run = getRun(db, c.req.param("id"));
    if (!run) throw notFound(`No run ${c.req.param("id")}`);
    const log = readRunLog(run.log_path);
    if (log === null) throw notFound(`The log for run ${run.id} is gone`);
    return c.text(log);
  });
  app.get(routes.run("tail"), (c) => {
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
