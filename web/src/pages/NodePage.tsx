import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import type { EdgeRow, NodeView } from "../../../src/shared/api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { PipelineRail } from "../components/PipelineRail.js";
import { StagePill } from "../components/StagePill.js";
import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";
import { pipelineFor } from "../lib/pipeline.js";
import { findType } from "../lib/stageStyle.js";
import { Actions } from "./node/Actions.js";
import { Description } from "./node/Description.js";
import { Edges } from "./node/Edges.js";
import { History } from "./node/History.js";
import { Links } from "./node/Links.js";
import { Messages } from "./node/Messages.js";

async function loadNode(nodeId: string) {
  const node = await api.node(nodeId);
  const [messages, events, edges, links, stages, projectNodes, projectEdges, projects] = await Promise.all([
    api.messages(nodeId),
    api.events(nodeId),
    api.edges(nodeId),
    api.links(nodeId),
    api.stages(node.project_id),
    api.nodes(node.project_id),
    api.projectEdges(node.project_id),
    api.projects(),
  ]);
  const project = projects.find((p) => p.id === node.project_id) ?? null;
  return { node, messages, events, edges, links, stages, projectNodes, projectEdges, project };
}

/** Oldest first, following each node's first `subtask` parent. */
function ancestorsOf(node: NodeView, nodes: NodeView[], edges: EdgeRow[]): NodeView[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: NodeView[] = [];
  const seen = new Set([node.id]);
  let current = node.id;
  for (;;) {
    const parentEdge = edges.find((e) => e.kind === "subtask" && e.target_id === current);
    const parent = parentEdge ? byId.get(parentEdge.source_id) : undefined;
    if (!parent || seen.has(parent.id)) return chain;
    seen.add(parent.id);
    chain.unshift(parent);
    current = parent.id;
  }
}

function turnLabel(node: NodeView): string {
  if (!node.stage_exists) return "Needs a human to move it";
  if (node.turn === "human") return "Your turn";
  if (node.turn === "agent") return "Agent's turn";
  return "Nobody's turn";
}

export function NodePage() {
  const { nodeId = "" } = useParams();
  const { data, error, reload } = useLiveData(() => loadNode(nodeId), nodeId);

  const titleOf = useMemo(() => {
    const titles = new Map(data?.projectNodes.map((n) => [n.id, n.title]));
    return (id: string) => titles.get(id) ?? id;
  }, [data]);

  if (!data) {
    return <div className="page">{error ? <ErrorNotice error={error} /> : <div className="loading">Loading…</div>}</div>;
  }

  const { node, stages, events, messages, projectNodes } = data;
  const pipeline = pipelineFor(node, findType(stages, node.type), events);
  const ancestors = ancestorsOf(node, projectNodes, data.projectEdges);
  const byParent = node.invalidated_by_parent && node.stage !== "invalidated";
  const nodeLink = (id: string) => (
    <Link key={id} to={`/n/${id}`} className="inline-link">
      {titleOf(id)}
    </Link>
  );

  return (
    <div className="page node-page" key={node.id}>
      <nav className="breadcrumb">
        <Link to={`/p/${node.project_id}`}>{data.project?.name ?? "Graph"}</Link>
        {ancestors.map((ancestor) => (
          <span key={ancestor.id}>
            <span className="crumb-sep">›</span>
            <Link to={`/n/${ancestor.id}`}>{ancestor.title}</Link>
          </span>
        ))}
        <span>
          <span className="crumb-sep">›</span>
          <span className="crumb-current">{node.title}</span>
        </span>
      </nav>

      {error ? <ErrorNotice error={error} /> : null}

      {!node.stage_exists ? (
        <div className="banner banner-danger" role="alert">
          <strong>This node's stage is gone.</strong> <code>{node.stage}</code> is no longer in type{" "}
          <code>{node.type}</code> in stages.yaml. Pick a stage for it with the move control below.
        </div>
      ) : null}
      {node.stage === "invalidated" ? (
        <div className="banner banner-danger">
          <strong>Invalidated:</strong> {node.invalidation_reason}
        </div>
      ) : null}
      {byParent ? (
        <div className="banner banner-warn">
          <strong>Invalidated by parent:</strong> invalidated ancestor{node.invalidated_ancestors.length > 1 ? "s" : ""}{" "}
          {node.invalidated_ancestors.map(nodeLink)}. Restoring {node.invalidated_ancestors.length > 1 ? "them" : "it"} clears this.
        </div>
      ) : null}
      {node.blocked_by.length > 0 ? (
        <div className="banner banner-warn">
          <strong>Blocked by</strong> {node.blocked_by.map(nodeLink)}. No agent starts here until{" "}
          {node.blocked_by.length > 1 ? "they finish" : "it finishes"}.
        </div>
      ) : null}
      {node.held ? (
        <div className="banner banner-warn">
          <strong>Held:</strong> {node.held_by.map(nodeLink)} {node.held_by.length > 1 ? "are" : "is"} still splitting. No
          agent starts here until the split finishes.
        </div>
      ) : null}

      <div className="node-head">
        <h1 className={node.stage === "invalidated" || byParent ? "title-dead" : undefined}>{node.title}</h1>
        <StagePill stage={node.stage} stages={stages} />
        {byParent ? <span className="badge badge-invalidated-by-parent">INVALIDATED BY PARENT</span> : null}
        {node.blocked_by.length > 0 ? <span className="badge badge-danger">BLOCKED</span> : null}
        {node.held ? <span className="badge badge-held">HELD</span> : null}
        <span className="turn-label">{turnLabel(node)}</span>
      </div>

      <section className="panel">
        <PipelineRail node={node} pipeline={pipeline} stages={stages} />
        <Actions node={node} stages={stages} messages={messages} events={events} reload={reload} />
      </section>

      <div className="node-columns">
        <div className="node-main">
          <Description node={node} reload={reload} />
          <Messages node={node} messages={messages} stages={stages} reload={reload} />
        </div>
        <aside className="node-side">
          <Links node={node} links={data.links} reload={reload} />
          <Edges node={node} edges={data.edges} nodes={projectNodes} stages={stages} reload={reload} />
          <History events={events} titleOf={titleOf} />
        </aside>
      </div>
    </div>
  );
}
