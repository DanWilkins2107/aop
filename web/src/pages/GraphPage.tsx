import { Background, Controls, MarkerType, ReactFlow, useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { NewNodeDialog } from "../components/NewNodeDialog.js";
import { RoutedEdge, type RoutedEdgeType } from "../components/RoutedEdge.js";
import { StageCard, type StageCardNode } from "../components/StageCard.js";
import { api } from "../lib/api.js";
import { CARD_HEIGHT, CARD_WIDTH, layoutGraph } from "../lib/layout.js";
import { useLiveData } from "../lib/live.js";
import { isInvalidated } from "../lib/stageStyle.js";

const nodeTypes = { stage: StageCard };
const edgeTypes = { routed: RoutedEdge };

const SUBTASK_STROKE = "#868e96";
const BLOCKS_STROKE = "#e03131";

// The left side clears the zoom controls.
const FIT = {
  padding: { top: "28px", right: "56px", bottom: "28px", left: "56px" },
  maxZoom: 1,
} as const;

const hideKey = (projectId: string) => `aop:hideInvalidated:${projectId}`;

function readHide(projectId: string): boolean {
  try {
    return localStorage.getItem(hideKey(projectId)) === "1";
  } catch {
    return false;
  }
}

function writeHide(projectId: string, hide: boolean): void {
  try {
    localStorage.setItem(hideKey(projectId), hide ? "1" : "0");
  } catch {
    // Only a convenience: the toggle still works until the page reloads.
  }
}

/** Fits the view when cards appear or go, and leaves the user's pan and zoom alone otherwise. */
function FitWhenCountChanges({ count }: { count: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (count > 0) void fitView({ ...FIT, duration: 150 });
  }, [count, fitView]);
  return null;
}

export function GraphPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [hideInvalidated, setHideInvalidated] = useState(() => readHide(projectId));

  const { data, error } = useLiveData(async () => {
    const [nodes, edges, stages, projects] = await Promise.all([
      api.nodes(projectId),
      api.projectEdges(projectId),
      api.stages(),
      api.projects(),
    ]);
    return { nodes, edges, stages, project: projects.find((p) => p.id === projectId) ?? null };
  }, projectId);

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!data) return { flowNodes: [] as StageCardNode[], flowEdges: [] as RoutedEdgeType[] };
    const nodes = hideInvalidated ? data.nodes.filter((n) => !isInvalidated(n)) : data.nodes;
    const shown = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter((e) => shown.has(e.source_id) && shown.has(e.target_id));
    const { positions, routes } = layoutGraph(
      nodes.map((n) => n.id),
      edges,
    );
    const stageOf = new Map(nodes.map((n) => [n.id, n.stage]));
    const flowNodes: StageCardNode[] = nodes.map((node) => ({
      id: node.id,
      type: "stage",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      data: { node, stages: data.stages },
    }));
    const flowEdges: RoutedEdgeType[] = edges.map((edge) => {
      // A finished blocker holds nothing any more, so its edge fades.
      const holding = stageOf.get(edge.source_id) !== "done";
      const stroke = edge.kind === "subtask" ? SUBTASK_STROKE : BLOCKS_STROKE;
      return {
        id: edge.id,
        source: edge.source_id,
        target: edge.target_id,
        type: "routed",
        data: { points: routes.get(edge.id) ?? [] },
        zIndex: edge.kind === "subtask" ? 0 : 1,
        style:
          edge.kind === "subtask"
            ? { stroke, strokeWidth: 2, opacity: 0.75 }
            : { stroke, strokeWidth: 2.5, strokeDasharray: "6 4", opacity: holding ? 1 : 0.3 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
    return { flowNodes, flowEdges };
  }, [data, hideInvalidated]);

  return (
    <div className="graph-page">
      <div className="graph-toolbar">
        <Link to="/" className="btn btn-small">
          ← Projects
        </Link>
        <h1>{data?.project?.name ?? ""}</h1>
        <span className="muted">
          {data
            ? `${flowNodes.length === data.nodes.length ? "" : `${flowNodes.length} of `}${data.nodes.length} ${data.nodes.length === 1 ? "node" : "nodes"}`
            : null}
        </span>
        <span className="topbar-spacer" />
        <label className="graph-filter">
          <input
            type="checkbox"
            checked={hideInvalidated}
            onChange={(e) => {
              writeHide(projectId, e.target.checked);
              setHideInvalidated(e.target.checked);
            }}
          />
          Hide invalidated
        </label>
        <button type="button" className="btn-create" disabled={!data} onClick={() => setCreating(true)}>
          + New node
        </button>
      </div>
      {error ? (
        <div className="graph-error">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      <div className="graph-canvas">
        {data && data.nodes.length === 0 ? (
          <div className="graph-empty">
            <strong>Nothing here yet</strong>
            <span className="muted">Create the first node to start the process.</span>
          </div>
        ) : null}
        {data && data.nodes.length > 0 && flowNodes.length === 0 ? (
          <div className="graph-empty">
            <strong>Every node here is hidden</strong>
            <span className="muted">
              They're all invalidated or invalidated by a parent. Turn off "Hide invalidated" to see them.
            </span>
          </div>
        ) : null}
        {data ? (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={FIT}
            minZoom={0.1}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1.5} color="#d5d9de" />
            <Controls showInteractive={false} position="bottom-left" />
            <FitWhenCountChanges count={flowNodes.length} />
          </ReactFlow>
        ) : null}
      </div>
      {creating && data ? (
        <NewNodeDialog
          projectId={projectId}
          stages={data.stages}
          onClose={() => setCreating(false)}
          onCreated={(node) => void navigate(`/n/${node.id}`)}
        />
      ) : null}
    </div>
  );
}
