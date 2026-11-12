import { Controls, MarkerType, ReactFlow, useReactFlow, type Viewport } from "@xyflow/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { NON_BLOCKING_STAGES } from "../../../src/shared/stages/nonBlockingStages.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { NewNodeDialog } from "../components/NewNodeDialog.js";
import { RoutedEdge, type RoutedEdgeType } from "../components/RoutedEdge.js";
import { StageCard, type StageCardNode } from "../components/StageCard.js";
import { withDescendants } from "../lib/ancestry.js";
import { loadProjectGraph } from "../lib/api.js";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  fittedViewport,
  inReadingOrder,
  layoutGraph,
  shownGraph,
  structureKey,
  type FitOptions,
} from "../lib/layout.js";
import { touchesProject } from "../lib/changes.js";
import { useLiveData } from "../lib/live.js";
import { isInvalidated } from "../lib/stageStyle.js";
import { useStoredFlag } from "../lib/storedFlag.js";

const nodeTypes = { stage: StageCard };
const edgeTypes = { routed: RoutedEdge };

const SUBTASK_STROKE = "#adb5bd";
/** Red, so a blocker reads apart from parent-to-child links. Matches `--danger` in base.css. */
const BLOCKS_STROKE = "#c92a2a";

/** Below this the canvas is a small window, so cards stay big enough to read. */
const NARROW_WIDTH = 640;

// The left side clears the zoom controls. Below half size the text can't be read, so a project too
// wide for that starts at its top left and pans instead.
const WIDE_FIT: FitOptions = { padding: { x: 56, y: 24 }, minZoom: 0.5, maxZoom: 1 };
const NARROW_FIT: FitOptions = { padding: { x: 16, y: 16 }, minZoom: 0.7, maxZoom: 1 };
// What the fit button does: the whole graph, however small.
const FIT_ALL = { padding: "16px", maxZoom: 1 } as const;

function readHidden(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The nodes hidden with a card's "Hide" button, remembered per project. Each takes its subtasks
 * with it. Like "Hide invalidated" it's only this browser's view: nothing about the node changes.
 */
function useHiddenNodes(projectId: string) {
  const key = `aop:hiddenNodes:${projectId}`;
  const [stored, setStored] = useState(() => ({ key, ids: readHidden(key) }));
  const ids = useMemo(() => (stored.key === key ? stored.ids : readHidden(key)), [stored, key]);
  const save = useCallback(
    (change: (ids: string[]) => string[]) => {
      setStored((current) => {
        const next = change(current.key === key ? current.ids : readHidden(key));
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Only a convenience: hiding still works until the page reloads.
        }
        return { key, ids: next };
      });
    },
    [key],
  );
  const hide = useCallback((id: string) => save((ids) => (ids.includes(id) ? ids : [...ids, id])), [save]);
  const show = useCallback((id: string) => save((ids) => ids.filter((other) => other !== id)), [save]);
  const showAll = useCallback(() => save(() => []), [save]);
  return { ids, hide, show, showAll };
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

const sameView = (a: Viewport, b: Viewport) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3;

/**
 * Fits the view to the cards, but only when which cards are shown changes: the first cards, a node
 * hidden or shown, or nodes added or removed. A change the user made by hiding or showing always
 * refits. One that arrives live refits only if the user hasn't moved the view since the last fit.
 * A refetch with the same cards, a stage change or a resize never moves the view.
 */
function FitOnNewCards({ structure, choice, viewport }: { structure: string; choice: string; viewport: Viewport }) {
  const { setViewport, getViewport } = useReactFlow();
  const last = useRef<{ structure: string; choice: string; fit: Viewport } | null>(null);
  useLayoutEffect(() => {
    const before = last.current;
    if (structure === "") return;
    if (before?.structure === structure) {
      last.current = { ...before, choice };
    } else if (before === null || before.choice !== choice || sameView(getViewport(), before.fit)) {
      void setViewport(viewport);
      last.current = { structure, choice, fit: viewport };
    } else {
      last.current = { ...before, structure, choice };
    }
    // Not on `viewport`: one that changed for any other reason, like a resize, mustn't move the view.
  }, [structure, choice, setViewport, getViewport]);
  return null;
}

export function GraphPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // Remembered per project.
  const [hideInvalidated, setHideInvalidated] = useStoredFlag(`aop:hideInvalidated:${projectId}`);
  const hidden = useHiddenNodes(projectId);
  const { ref: canvasRef, size } = useSize();
  // React Flow applies its starting view just after it mounts, so it stays hidden until then.
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const narrow = size !== null && size.width < NARROW_WIDTH;

  const { data, error } = useLiveData(() => loadProjectGraph(projectId), projectId, {
    affects: (notice) => touchesProject(notice, projectId),
  });

  // The nodes hidden by hand that still exist, each with how many cards go with it.
  const { hiddenRoots, hiddenIds } = useMemo(() => {
    if (!data) return { hiddenRoots: [], hiddenIds: new Set<string>() };
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const hiddenRoots = hidden.ids.flatMap((id) => {
      const node = byId.get(id);
      return node ? [{ node, under: withDescendants([id], data.edges).size - 1 }] : [];
    });
    return { hiddenRoots, hiddenIds: withDescendants(hidden.ids, data.edges) };
  }, [data, hidden.ids]);

  const shown = useMemo(
    () =>
      data
        ? shownGraph(data.nodes, data.edges, (n) => hiddenIds.has(n.id) || (hideInvalidated && isInvalidated(n)))
        : null,
    [data, hiddenIds, hideInvalidated],
  );
  const structure = shown ? structureKey(shown.nodes, shown.edges) : "";
  // Laid out again only when `structure`, which is everything the layout reads from `shown`, changes.
  const layout = useMemo(() => (shown ? layoutGraph(shown.nodes.map((n) => n.id), shown.edges) : null), [structure]);
  // The user's own hiding choices: when these change, the view refits even if they'd moved it.
  const choice = `${projectId}|${hideInvalidated ? 1 : 0}|${hidden.ids.join(",")}`;

  const { flowNodes, flowEdges, viewport } = useMemo(() => {
    const none: Viewport = { x: 0, y: 0, zoom: 1 };
    if (!data || !size || !shown || !layout)
      return { flowNodes: [] as StageCardNode[], flowEdges: [] as RoutedEdgeType[], viewport: none };
    const { nodes, edges } = shown;
    const { positions, routes } = layout;
    const stageOf = new Map(nodes.map((n) => [n.id, n.stage]));
    const flowNodes: StageCardNode[] = inReadingOrder(nodes, positions).map((node) => ({
      id: node.id,
      type: "stage",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      data: { node, stages: data.stages, onHide: hidden.hide },
    }));
    const flowEdges: RoutedEdgeType[] = edges.map((edge) => {
      // A done or invalidated blocker holds nothing any more, so its edge fades.
      const holding = !NON_BLOCKING_STAGES.includes(stageOf.get(edge.source_id) ?? "");
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
    const shownAt = flowNodes.map((node) => node.position);
    return { flowNodes, flowEdges, viewport: fittedViewport(shownAt, size, narrow ? NARROW_FIT : WIDE_FIT) };
  }, [data, shown, layout, hidden.hide, size, narrow]);

  return (
    <div className="graph-page">
      <div className="graph-toolbar">
        <nav className="breadcrumb graph-crumbs">
          <Link to="/">Projects</Link>
          <span className="crumb-sep">›</span>
          <h1>{data?.project?.name ?? ""}</h1>
        </nav>
        <div className="graph-tools">
          {hiddenRoots.length > 0 ? (
            <details className="graph-hidden">
              <summary>Hidden ({hiddenRoots.length})</summary>
              <div className="graph-hidden-menu">
                <ul>
                  {hiddenRoots.map(({ node, under }) => (
                    <li key={node.id}>
                      <span className="graph-hidden-name">
                        <Link to={`/n/${node.id}`}>{node.title}</Link>
                        {under > 0 ? <span className="muted"> and {under} under it</span> : null}
                      </span>
                      <button type="button" onClick={() => hidden.show(node.id)} aria-label={`Show "${node.title}"`}>
                        Show
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={hidden.showAll}>
                  Show all
                </button>
              </div>
            </details>
          ) : null}
          <label className="graph-filter">
            <input type="checkbox" checked={hideInvalidated} onChange={(e) => setHideInvalidated(e.target.checked)} />
            Hide invalidated
          </label>
          <Link to={`/p/${projectId}/settings`} className="quiet-link">
            Settings
          </Link>
          <button type="button" disabled={!data} onClick={() => setCreating(true)}>
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
              Turn off "Hide invalidated", or show nodes from the "Hidden" list, to see them.
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
            // Each card's own link is its one stop for Tab. React Flow's would add an unnamed stop per
            // card and per edge, described with select and move keys that do nothing here.
            nodesFocusable={false}
            edgesFocusable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT_ALL} />
            <FitOnNewCards structure={flowNodes.length > 0 ? structure : ""} choice={choice} viewport={viewport} />
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
