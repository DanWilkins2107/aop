import type { EventView } from "../../../../src/shared/events/types.js";
import type { EdgeRow, NodeView } from "../../../../src/shared/nodes/types.js";
import { Edges } from "./Edges.js";
import { History } from "./History.js";
import { Part } from "./Part.js";
import { Runs } from "./Runs.js";

/** At the bottom of the page: edges and history, then the node's agent runs and the latest one's log. */
export function Details({
  node,
  edges,
  nodes,
  events,
  titleOf,
  reload,
}: {
  node: NodeView;
  edges: EdgeRow[];
  nodes: NodeView[];
  events: EventView[];
  titleOf: (id: string) => string;
  reload: () => Promise<void>;
}) {
  return (
    <section className="panel" aria-label="Details">
      <h2>Details</h2>
      <Part title="Edges" status={edges.length}>
        <Edges node={node} edges={edges} nodes={nodes} reload={reload} />
      </Part>
      <Part title="History" status={events.length}>
        <History events={events} titleOf={titleOf} />
      </Part>
      <Runs node={node} />
    </section>
  );
}
