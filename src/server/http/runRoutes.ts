// Agents, their runs and their logs, and the branches a node's runs work.

import { apiPaths } from "../../shared/http/apiPaths.js";
import type { LogTail } from "../../shared/runs/types.js";
import { listBranchViews } from "../nodes/branchViews.js";
import { getNodeRow } from "../nodes/nodes.js";
import { readableLines } from "../runs/agentOutput.js";
import { readLogEnd, readRunLog } from "../runs/runLog.js";
import { getRun, listRuns } from "../runs/runs.js";
import { badRequest, notFound } from "../shared/errors.js";
import type { RouteContext } from "./routeContext.js";
import { at, routes } from "./routes.js";

/** How much of a run's log the node page shows. */
const TAIL_LINES = 20;
const MAX_TAIL_LINES = 200;

export function runRoutes({ app, db, orchestrator }: RouteContext): void {
  app.get(at(apiPaths.agents), async (c) => c.json(await orchestrator().listAgents()));
  app.post(at(apiPaths.reap), async (c) => c.json(await orchestrator().reap()));
  app.post(routes.run("stop"), async (c) => c.json(await orchestrator().stopRun(c.req.param("id"))));
  app.get(routes.nodeAction("runs"), (c) => {
    const node = getNodeRow(db, c.req.param("id"));
    return c.json(listRuns(db, node.id));
  });
  app.get(routes.nodeAction("branches"), (c) => c.json(listBranchViews(db, c.req.param("id"))));
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
}
