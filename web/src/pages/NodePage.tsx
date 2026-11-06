import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import type { LinkRow } from "../../../src/shared/api.js";
import { ClaimMark } from "../components/ClaimMark.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { PipelineGraph } from "../components/PipelineGraph.js";
import { ancestorsOf } from "../lib/ancestry.js";
import { api, loadProjectGraph } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { useLiveData } from "../lib/live.js";
import { originalStage } from "../lib/stageGraph.js";
import { GLOBAL_STAGES, findType, stageBand } from "../lib/stageStyle.js";
import { Description } from "./node/Description.js";
import { Details } from "./node/Details.js";
import { Messages } from "./node/Messages.js";
import { MovingOn } from "./node/MovingOn.js";

async function loadNode(nodeId: string) {
  const node = await api.node(nodeId);
  const [messages, events, edges, links, graph] = await Promise.all([
    api.messages(nodeId),
    api.events(nodeId),
    api.edges(nodeId),
    api.links(nodeId),
    loadProjectGraph(node.project_id),
  ]);
  const { stages, nodes: projectNodes, edges: projectEdges, project } = graph;
  return { node, messages, events, edges, links, stages, projectNodes, projectEdges, project };
}

const LINK_LABELS: Record<LinkRow["kind"], string> = { pr: "PR", ticket: "Ticket" };

/** Plain links named by kind. A second of the same kind gets a number, to tell them apart. */
function Links({ links }: { links: LinkRow[] }) {
  if (links.length === 0) return null;
  const seen = new Map<string, number>();
  return (
    <p className="meta-links">
      {links.map((link) => {
        const count = (seen.get(link.kind) ?? 0) + 1;
        seen.set(link.kind, count);
        return (
          <a key={link.id} href={link.url} target="_blank" rel="noreferrer" title={link.url} data-link-kind={link.kind}>
            {LINK_LABELS[link.kind]}
            {count > 1 ? ` ${count}` : ""}
          </a>
        );
      })}
    </p>
  );
}

export function NodePage() {
  const { nodeId = "" } = useParams();
  const { data, error, reload } = useLiveData(() => loadNode(nodeId), nodeId);

  const titleOf = useMemo(() => {
    const titles = new Map(data?.projectNodes.map((n) => [n.id, n.title]));
    return (id: string) => titles.get(id) ?? id;
  }, [data]);

  if (!data) {
    return <div className="page page-narrow">{error ? <ErrorNotice error={error} /> : <div className="loading">Loading…</div>}</div>;
  }

  const { node, stages, events, messages, projectNodes } = data;
  const ancestors = ancestorsOf(node, projectNodes, data.projectEdges);
  const byParent = node.invalidated_by_parent && node.stage !== "invalidated";
  const onGlobalStage = GLOBAL_STAGES.includes(node.stage);
  const band = stageBand(node, stages);
  const nodeLink = (id: string) => (
    <Link key={id} to={`/n/${id}`} className="inline-link">
      {titleOf(id)}
    </Link>
  );

  return (
    <div className="node-canvas">
      <div className="page node-page" key={node.id}>
        <nav className="breadcrumb">
          <Link to={`/p/${node.project_id}`}>{data.project?.name ?? "Graph"}</Link>
          {ancestors.map((ancestor) => (
            <span key={ancestor.id}>
              <span className="crumb-sep">›</span>
              <Link to={`/n/${ancestor.id}`}>{ancestor.title}</Link>
            </span>
          ))}
        </nav>

        {error ? <ErrorNotice error={error} /> : null}

        <header className="panel node-meta">
          <p className="stage-band" style={{ background: band.background, color: band.text }}>
            <span>{humanize(node.stage)}</span>
            <ClaimMark node={node} />
          </p>
          <h1 className={node.stage === "invalidated" || byParent ? "title-dead" : undefined}>{node.title}</h1>
          {!node.stage_exists ? (
            <p className="meta-note meta-note-alert" role="alert">
              This node's stage is gone. <code>{node.stage}</code> is no longer in type <code>{node.type}</code> in
              stages.yaml.
            </p>
          ) : null}
          {node.stage === "invalidated" ? <p className="meta-note">Invalidated: {node.invalidation_reason}</p> : null}
          {byParent ? (
            <p className="meta-note">
              Invalidated by parent {node.invalidated_ancestors.map(nodeLink)}. Restoring{" "}
              {node.invalidated_ancestors.length > 1 ? "them" : "it"} clears this.
            </p>
          ) : null}
          {node.blocked_by.length > 0 ? (
            <p className="meta-note">
              Blocked by {node.blocked_by.map(nodeLink)}. No agent starts here until{" "}
              {node.blocked_by.length > 1 ? "they finish" : "it finishes"}.
            </p>
          ) : null}
          {node.held ? (
            <p className="meta-note">
              Held: {node.held_by.map(nodeLink)} {node.held_by.length > 1 ? "are" : "is"} still splitting. No agent starts
              here until the split finishes.
            </p>
          ) : null}
          <Links links={data.links} />
          <MovingOn node={node} stages={stages} events={events} reload={reload} />
          <details className="panel-part pipeline-part">
            <summary>Pipeline</summary>
            {onGlobalStage ? <p className="pipeline-note muted">{humanize(node.stage)} is a global stage. Global stages live outside the pipeline.</p> : null}
            <PipelineGraph
              node={node}
              type={findType(stages, node.type)}
              returnTo={onGlobalStage ? originalStage(node, events) : null}
            />
          </details>
        </header>

        <Description node={node} reload={reload} />
        <Messages node={node} messages={messages} events={events} stages={stages} reload={reload} />
        <Details node={node} edges={data.edges} nodes={projectNodes} events={events} stages={stages} titleOf={titleOf} reload={reload} />
      </div>
    </div>
  );
}
