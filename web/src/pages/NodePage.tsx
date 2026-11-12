import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  EdgeRow,
  EventView,
  ImprovementDetail,
  ImprovementSource,
  LinkRow,
  MessageRow,
  NodeView,
  ProjectRow,
  ProposalView,
  StagesView,
} from "../../../src/shared/api/types.js";
import { GLOBAL_STAGES } from "../../../src/shared/domain/builtInStages.js";
import { ClaimMark } from "../components/ClaimMark.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { PipelineGraph } from "../components/PipelineGraph.js";
import { ancestorsOf } from "../lib/ancestry.js";
import { api, loadProjectGraph } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { touchesNode, touchesProject } from "../lib/changes.js";
import { type Refresh, useLiveData } from "../lib/live.js";
import { originalStage } from "../lib/stageGraph.js";
import { findType, stageBand } from "../lib/stageStyle.js";
import { NodeControls } from "./node/Controls.js";
import { Description } from "./node/Description.js";
import { Details } from "./node/Details.js";
import { Messages } from "./node/Messages.js";
import { MovingOn } from "./node/MovingOn.js";
import { Part } from "./node/Part.js";
import { Proposals } from "./node/Proposals.js";

const loadOwn = (nodeId: string) =>
  Promise.all([api.messages(nodeId), api.events(nodeId), api.edges(nodeId), api.links(nodeId)]).then(
    ([messages, events, edges, links]) => ({ messages, events, edges, links }),
  );

/** An improvement belongs to no project and follows its own pipeline, so it's read whole each time. */
async function loadImprovement(node: NodeView): Promise<NodeData> {
  const [own, stages, improvement, proposals] = await Promise.all([
    loadOwn(node.id),
    api.improvementStages(),
    api.improvement(node.id),
    api.proposals(node.id),
  ]);
  return { node, ...own, stages, projectNodes: [node], projectEdges: [], project: null, improvement, proposals };
}

/**
 * The node, its own messages, events, edges and links, and its project's graph. On a refetch the node's
 * project is known, and a node never changes project, so the node comes from the project's nodes and its
 * own parts are read again only if the change touched them.
 */
async function loadNode(nodeId: string, refresh: Refresh<NodeData> | null): Promise<NodeData> {
  const previous = refresh?.previous ?? null;
  if (previous?.node.kind === "improvement") return loadImprovement(await api.node(nodeId));
  const ownChanged = refresh === null || touchesNode(refresh.change, nodeId, refresh.previous.node.project_id);
  const first = previous === null ? await api.node(nodeId) : null;
  if (first?.kind === "improvement") return loadImprovement(first);
  const projectId = first?.project_id ?? previous!.node.project_id;
  const [own, graph] = await Promise.all([
    ownChanged || previous === null ? loadOwn(nodeId) : previous,
    loadProjectGraph(projectId),
  ]);
  // Gone from its project means deleted, and this says so.
  const node = first ?? graph.nodes.find((n) => n.id === nodeId) ?? (await api.node(nodeId));
  const { messages, events, edges, links } = own;
  const { stages, nodes: projectNodes, edges: projectEdges, project } = graph;
  return { node, messages, events, edges, links, stages, projectNodes, projectEdges, project, improvement: null, proposals: [] };
}

/** "From: <message>", linking back to the message the improvement was captured from. */
function SourceLink({ source }: { source: ImprovementSource | null }) {
  if (source === null) return null;
  const excerpt = source.excerpt.length > 160 ? `${source.excerpt.slice(0, 159)}…` : source.excerpt;
  const where = `${source.project_name ?? "a deleted project"} › ${source.node_title}`;
  return (
    <p className="meta-note improvement-source">
      From:{" "}
      {source.node_id !== null ? (
        <Link to={`/n/${source.node_id}${source.message_id ? `#m-${source.message_id}` : ""}`} className="inline-link" title={where}>
          {excerpt}
        </Link>
      ) : (
        <span title={where}>{excerpt}</span>
      )}{" "}
      <span className="muted">({where})</span>
    </p>
  );
}

interface NodeData {
  node: NodeView;
  messages: MessageRow[];
  events: EventView[];
  edges: EdgeRow[];
  links: LinkRow[];
  stages: StagesView;
  projectNodes: NodeView[];
  projectEdges: EdgeRow[];
  project: ProjectRow | null;
  /** Set for an improvement. */
  improvement: ImprovementDetail | null;
  proposals: ProposalView[];
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
  const { data, error, reload } = useLiveData<NodeData>((refresh) => loadNode(nodeId, refresh), nodeId, {
    // The node's view depends on the rest of its project: its holders, and its parents' titles. An
    // improvement's also shows its source, in another project.
    affects: (notice, shown) =>
      shown === null ||
      touchesProject(notice, shown.node.project_id) ||
      (shown.improvement?.source?.project_id != null && touchesProject(notice, shown.improvement.source.project_id)),
  });

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
          {data.improvement ? (
            <Link to="/improvements">Improvements</Link>
          ) : (
            <Link to={`/p/${node.project_id}`}>{data.project?.name ?? "Graph"}</Link>
          )}
        </nav>

        {error ? <ErrorNotice error={error} /> : null}

        <header className="panel node-meta">
          <p className="stage-band" style={{ background: band.background, color: band.text }}>
            <span>{humanize(node.stage)}</span>
            <ClaimMark node={node} />
          </p>
          <h1 className={node.stage === "invalidated" || byParent ? "title-dead" : undefined}>{node.title}</h1>
          {data.improvement ? <SourceLink source={data.improvement.source} /> : null}
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
          <MovingOn node={node} stages={stages} events={events} proposals={data.improvement ? data.proposals : undefined} reload={reload} />
          <div className="panel-part header-parts">
            <Part title="Pipeline">
              {onGlobalStage ? (
                <p className="pipeline-note muted">{humanize(node.stage)} is a global stage. Global stages live outside the pipeline.</p>
              ) : null}
              <PipelineGraph
                node={node}
                type={findType(stages, node.type)}
                returnTo={onGlobalStage ? originalStage(node, events) : null}
              />
            </Part>
            {ancestors.length > 0 ? (
              <Part title="Parents" status={ancestors.length}>
                <ol className="parents-list">
                  {ancestors.map((ancestor) => (
                    <li key={ancestor.id}>{nodeLink(ancestor.id)}</li>
                  ))}
                </ol>
              </Part>
            ) : null}
            <NodeControls node={node} stages={stages} reload={reload} />
          </div>
        </header>

        <Description node={node} reload={reload} />
        {data.improvement ? <Proposals node={node} proposals={data.proposals} reload={reload} /> : null}
        <Messages node={node} messages={messages} events={events} stages={stages} reload={reload} />
        <Details node={node} edges={data.edges} nodes={projectNodes} events={events} titleOf={titleOf} reload={reload} />
      </div>
    </div>
  );
}
