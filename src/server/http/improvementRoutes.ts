// Proposals are stored here; only apply writes files, only for a human, and only where allowedTarget says.
// It has no MCP tool.

import { apiPaths } from "../../shared/http/apiPaths.js";
import { EVERYTHING } from "../db/changes.js";
import { applyProposals } from "../improvements/applyProposals.js";
import { createImprovement, getImprovement, listImprovements, listProposals, propose, withdraw } from "../improvements/improvements.js";
import { applyBody, improvementBody, proposalBody, withdrawBody } from "./requests.js";
import { readBody, type RouteContext } from "./routeContext.js";
import { at, routes } from "./routes.js";

export function improvementRoutes({ app, db, touch }: RouteContext): void {
  app.get(at(apiPaths.improvements), (c) => c.json(listImprovements(db)));
  app.post(at(apiPaths.improvements), async (c) => c.json(createImprovement(db, await readBody(c, improvementBody)), 201));
  app.get(routes.improvement, (c) => c.json(getImprovement(db, c.req.param("id"))));
  app.get(routes.improvementAction("proposals"), (c) => c.json(listProposals(db, c.req.param("id"))));
  app.put(routes.improvementAction("proposals"), async (c) =>
    c.json(propose(db, c.req.param("id"), await readBody(c, proposalBody))),
  );
  app.delete(routes.improvementAction("proposals"), async (c) =>
    c.json(withdraw(db, c.req.param("id"), await readBody(c, withdrawBody))),
  );
  // Applying writes real files, which can include stage prompts, and so whether the config is valid:
  // every page refetches.
  app.post(routes.improvementAction("apply"), async (c) => {
    touch(c, EVERYTHING);
    return c.json(applyProposals(db, c.req.param("id"), await readBody(c, applyBody)));
  });
}
