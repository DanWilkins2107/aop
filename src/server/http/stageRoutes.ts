// The process and the config, read from disk whenever they have changed. Read-only on purpose: agents can
// reach this API, so no route may change commands.

import { apiPaths } from "../../shared/http/apiPaths.js";
import { describeConfig, loadConfig } from "../config/config.js";
import { describeProcess } from "../config/processView.js";
import { graphFor, graphsOf } from "../nodes/nodes.js";
import { getProject } from "../projects/projects.js";
import { describeStages, EMPTY_GRAPH } from "../stages/stages.js";
import type { RouteContext } from "./routeContext.js";
import { at } from "./routes.js";

export function stageRoutes({ app, db }: RouteContext): void {
  // The shared process, or with `?project=` the one that project follows.
  app.get(at(apiPaths.stages), (c) => {
    const project = c.req.query("project");
    const config = loadConfig();
    if (project === undefined) return c.json(describeStages(config.graph));
    const projectId = getProject(db, project).id;
    return c.json(describeStages(graphFor(graphsOf(config), { kind: "work", project_id: projectId })));
  });
  // For the process page, which still answers when the config is invalid, listing the problems.
  app.get(at(apiPaths.process), (c) => c.json(describeProcess()));

  app.get(at(apiPaths.improvementStages), (c) => c.json(describeStages(loadConfig().improvementGraph ?? EMPTY_GRAPH)));

  app.get(at(apiPaths.config), (c) => c.json(describeConfig()));
}
