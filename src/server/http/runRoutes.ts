// Agents, their runs and their logs.

import { apiPaths } from "../../shared/http/apiPaths.js";
import { z } from "zod";
import type { LogTail } from "../../shared/runs/types.js";
import { EVERYTHING } from "../db/changes.js";
import { getNodeRow } from "../nodes/nodes.js";
import { readableLines } from "../runs/agentOutput.js";
import { readLogEnd, readRunLog } from "../runs/runLog.js";
import { getRun, listRuns } from "../runs/runs.js";
import { badRequest, notFound } from "../shared/errors.js";
import { readBody, type RouteContext } from "./routeContext.js";
import { at, routes } from "./routes.js";

/** How much of a run's log the node page shows. */
const TAIL_LINES = 20;
const MAX_TAIL_LINES = 200;

const agentLimitBody = z.object({ limit: z.number().int().min(0).nullable() });

export function runRoutes({ app, db, orchestrator, touch }: RouteContext): void {
  app.get(at(apiPaths.agents), async (c) => c.json(await orchestrator().listAgents()));
  app.get(at(apiPaths.agentLimit), (c) => c.json(orchestrator().agentLimit()));
  app.put(at(apiPaths.agentLimit), async (c) => {
    const { limit } = await readBody(c, agentLimitBody);
    // Every page that shows the limit refetches, in every open tab.
    touch(c, EVERYTHING);
    return c.json(orchestrator().setAgentLimit(limit));
  });
  app.post(at(apiPaths.reap), async (c) => c.json(await orchestrator().reap()));
  app.post(routes.run("stop"), async (c) => c.json(await orchestrator().stopRun(c.req.param("id"))));
  app.get(routes.nodeAction("runs"), (c) => {
    const node = getNodeRow(db, c.req.param("id"));
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
}
