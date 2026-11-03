import { Controls, MarkerType, ReactFlow, useReactFlow, type Viewport } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { NewNodeDialog } from "../components/NewNodeDialog.js";
import { RoutedEdge, type RoutedEdgeType } from "../components/RoutedEdge.js";
import { StageCard, type StageCardNode } from "../components/StageCard.js";
import { api } from "../lib/api.js";
import { CARD_HEIGHT, CARD_WIDTH, NARROW_ASPECT, WIDE_ASPECT, fittedViewport, layoutGraph, type FitOptions } from "../lib/layout.js";
import { useLiveData } from "../lib/live.js";
import { isInvalidated } from "../lib/stageStyle.js";

const nodeTypes = { stage: StageCard };
const edgeTypes = { routed: RoutedEdge };

const SUBTASK_STROKE = "#adb5bd";
const BLOCKS_STROKE = "#495057";

/** Below this the canvas is a small window: fewer cards to a row, and big enough to read. */
const NARROW_WIDTH = 640;

// The left side clears the zoom controls.
const WIDE_FIT: FitOptions = { padding: { x: 56, y: 24 }, minZoom: 0.1, maxZoom: 1 };
const NARROW_FIT: FitOptions = { padding: { x: 16, y: 16 }, minZoom: 0.7, maxZoom: 1 };
// What the fit button does: the whole graph, however small.
const FIT_ALL = { padding: "16px", maxZoom: 1 } as const;

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

/** The canvas's size, known before anything paints. */
function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

/** Fits the view when cards appear or go, and leaves the user's pan and zoom alone otherwise. */
function FitWhenChanged({ fitKey, viewport }: { fitKey: string; viewport: Viewport }) {
  const { setViewport } = useReactFlow();
  useLayoutEffect(() => {
    void setViewport(viewport);
    // Only on `fitKey`: a viewport that changed for any other reason mustn't move the user's view.
  }, [fitKey, setViewport]);
  return null;
}

export function GraphPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [hideInvalidated, setHideInvalidated] = useState(() => readHide(projectId));
  const { ref: canvasRef, size } = useSize();
  // React Flow applies its starting view just after it mounts, so it stays hidden until then.
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const narrow = size !== null && size.width < NARROW_WIDTH;

  const { data, error } = useLiveData(async () => {
    const [nodes, edges, stages, projects] = await Promise.all([
      api.nodes(projectId),
      api.projectEdges(projectId),
      api.stages(),
      api.projects(),
    ]);
    return { nodes, edges, stages, project: projects.find((p) => p.id === projectId) ?? null };
  }, projectId);

  const { flowNodes, flowEdges, viewport } = useMemo(() => {
    const none: Viewport = { x: 0, y: 0, zoom: 1 };
    if (!data || !size) return { flowNodes: [] as StageCardNode[], flowEdges: [] as RoutedEdgeType[], viewport: none };
    const nodes = hideInvalidated ? data.nodes.filter((n) => !isInvalidated(n)) : data.nodes;
    const shown = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter((e) => shown.has(e.source_id) && shown.has(e.target_id));
    const { positions, routes } = layoutGraph(
      nodes.map((n) => n.id),
      edges,
      narrow ? NARROW_ASPECT : WIDE_ASPECT,
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
            ? { stroke, strokeWidth: 1.5 }
            : { stroke, strokeWidth: 1.5, strokeDasharray: "5 4", opacity: holding ? 1 : 0.3 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
    return { flowNodes, flowEdges, viewport: fittedViewport(positions.values(), size, narrow ? NARROW_FIT : WIDE_FIT) };
  }, [data, hideInvalidated, size, narrow]);

  return (
    <div className="graph-page">
      <div className="graph-toolbar">
        <nav className="breadcrumb graph-crumbs">
          <Link to="/">Projects</Link>
          <span className="crumb-sep">›</span>
          <h1>{data?.project?.name ?? ""}</h1>
        </nav>
        <div className="graph-tools">
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
          <Link to={`/p/${projectId}/settings`} className="quiet-link">
            Settings
          </Link>
          <button type="button" className="btn-small" disabled={!data} onClick={() => setCreating(true)}>
            New node
          </button>
        </div>
      </div>
      {error ? (
        <div className="graph-error">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      <div className="graph-canvas" ref={canvasRef}>
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
        {data && size ? (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={viewport}
            onInit={() => setReadyFor(projectId)}
            style={{ visibility: readyFor === projectId ? "visible" : "hidden" }}
            minZoom={0.1}
            zoomOnDoubleClick={false}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT_ALL} />
            <FitWhenChanged fitKey={`${flowNodes.length}:${narrow}`} viewport={viewport} />
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
