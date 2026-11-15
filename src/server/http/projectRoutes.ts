import { apiPaths } from "../../shared/http/apiPaths.js";
import { addProject, deleteProject, getProject, listProjects, updateProject } from "../projects/projects.js";
import { deleteLogs } from "../runs/runLog.js";
import { projectLogPaths } from "../runs/runs.js";
import { addProjectBody, updateProjectBody } from "./requests.js";
import { readBody, type RouteContext } from "./routeContext.js";
import { at, routes } from "./routes.js";

export function projectRoutes({ app, db, maybeOrchestrator, touch, touchedProject }: RouteContext): void {
  app.get(at(apiPaths.projects), (c) => c.json(listProjects(db)));
  app.post(at(apiPaths.projects), async (c) => {
    const project = addProject(db, await readBody(c, addProjectBody));
    touch(c, touchedProject(project.id));
    return c.json(project, 201);
  });
  app.patch(routes.project, async (c) => {
    const project = updateProject(db, c.req.param("id"), await readBody(c, updateProjectBody));
    touch(c, touchedProject(project.id));
    return c.json(project);
  });
  app.delete(routes.project, async (c) => {
    const { id } = getProject(db, c.req.param("id"));
    // Agents stop first, and none can start on the project until it has gone.
    const reopen = await maybeOrchestrator?.stopProjectAgents(id);
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
    touch(c, touchedProject(id, null));
    return c.json(deleted);
  });
}
