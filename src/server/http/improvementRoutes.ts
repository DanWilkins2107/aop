// Proposals are stored here; only apply writes files, only for a human, and only where allowedTarget says.
// It has no MCP tool. Each write says what it touched: the improvement, and on capture the work node it
// came from.

import { apiPaths } from "../../shared/http/apiPaths.js";
import { applyProposals } from "../improvements/applyProposals.js";
import { createImprovement, getImprovement, listImprovements, listProposals, propose, withdraw } from "../improvements/improvements.js";
import { applyBody, improvementBody, proposalBody, withdrawBody } from "./requests.js";
import { readBody, type RouteContext } from "./routeContext.js";
import { at, routes } from "./routes.js";

export function improvementRoutes({ app, db, touch, touchedNodes }: RouteContext): void {
  app.get(at(apiPaths.improvements), (c) => c.json(listImprovements(db)));
  app.post(at(apiPaths.improvements), async (c) => {
    const improvement = createImprovement(db, await readBody(c, improvementBody));
    const source = improvement.source?.node_id;
    touch(c, touchedNodes(improvement.node.id, ...(source == null ? [] : [source])));
    return c.json(improvement, 201);
  });
  app.get(routes.improvement, (c) => c.json(getImprovement(db, c.req.param("id"))));
  app.get(routes.improvementAction("proposals"), (c) => c.json(listProposals(db, c.req.param("id"))));
  app.put(routes.improvementAction("proposals"), async (c) => {
    const proposal = propose(db, c.req.param("id"), await readBody(c, proposalBody));
    touch(c, touchedNodes(c.req.param("id")));
    return c.json(proposal);
  });
  app.delete(routes.improvementAction("proposals"), async (c) => {
    const withdrawn = withdraw(db, c.req.param("id"), await readBody(c, withdrawBody));
    touch(c, touchedNodes(c.req.param("id")));
    return c.json(withdrawn);
  });
  // Applying writes real files, which can include stage prompts, and so whether the config is valid:
  // it records nothing narrower, so every page refetches.
  app.post(routes.improvementAction("apply"), async (c) =>
    c.json(applyProposals(db, c.req.param("id"), await readBody(c, applyBody))),
  );
}
