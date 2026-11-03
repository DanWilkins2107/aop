import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import { smoothPath, type Point } from "../lib/layout.js";

export type RoutedEdgeType = Edge<{ points: Point[] }, "routed">;

/** Follows the route the layout chose, which goes around the cards in between. */
export function RoutedEdge({ data, style, markerEnd }: EdgeProps<RoutedEdgeType>) {
  return <BaseEdge path={smoothPath(data?.points ?? [])} {...(style ? { style } : {})} {...(markerEnd ? { markerEnd } : {})} />;
}
