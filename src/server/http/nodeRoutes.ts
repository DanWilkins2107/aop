// Nodes and everything on them: stage changes, claims, messages, links, edges, events and search.

import { apiPaths } from "../../shared/http/apiPaths.js";
import * as nodes from "../nodes/nodes.js";
import { search } from "../nodes/search.js";
import { getProject } from "../projects/projects.js";
import { nodeContext } from "../runs/context.js";
import { prepareSteer } from "../runs/steer.js";
import { setSchedule } from "../schedule/schedule.js";
import { badRequest } from "../shared/errors.js";
import {
  actorBody,
  answerBody,
  askBody,
  blockBody,
  claimBody,
  createNodeBody,
  edgeBody,
  editNodeBody,
  failBody,
  invalidateBody,
  linkBody,
  messageBody,
  moveBody,
  nextBody,
  scheduleBody,
  steerBody,
  unblockBody,
} from "./requests.js";
import { readBody, type RouteContext, runIdOf } from "./routeContext.js";
import { at, routes } from "./routes.js";

export function nodeRoutes({ app, db }: RouteContext): void {
  app.get(routes.projectAction("edges"), (c) => {
    const project = getProject(db, c.req.param("id"));
    return c.json(nodes.listProjectEdges(db, project.id));
  });

  app.get(routes.projectAction("nodes"), (c) => {
    const project = getProject(db, c.req.param("id"));
    return c.json(nodes.listNodes(db, project.id));
  });
  app.post(routes.projectAction("nodes"), async (c) => {
    const project = getProject(db, c.req.param("id"));
    const body = await readBody(c, createNodeBody);
    return c.json(nodes.createNode(db, project.id, body), 201);
  });
  app.get(routes.node, (c) => c.json(nodes.getNode(db, c.req.param("id"))));
  app.patch(routes.node, async (c) =>
    c.json(nodes.editNode(db, c.req.param("id"), await readBody(c, editNodeBody))),
  );

  app.get(routes.nodeAction("context"), (c) => c.text(nodeContext(db, c.req.param("id"), runIdOf(c))));
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
    c.json(setSchedule(db, c.req.param("id"), await readBody(c, scheduleBody))),
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
    c.json(nodes.addMessage(db, c.req.param("id"), { ...(await readBody(c, messageBody)), runId: runIdOf(c) }), 201),
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
  app.post(routes.nodeAction("edges"), async (c) =>
    c.json(nodes.addEdge(db, c.req.param("id"), await readBody(c, edgeBody)), 201),
  );
  app.delete(routes.edge, async (c) =>
    c.json(nodes.removeEdge(db, c.req.param("id"), (await readBody(c, actorBody, true)).actor)),
  );

  // Events
  app.get(routes.nodeAction("events"), (c) => c.json(nodes.listEvents(db, c.req.param("id"))));

  app.get(at(apiPaths.search), (c) => {
    const query = c.req.query("q");
    if (query === undefined || query.trim() === "") throw badRequest("Search needs a query, in q");
    const project = c.req.query("project");
    return c.json(search(db, query, project === undefined ? null : getProject(db, project).id));
  });
}
