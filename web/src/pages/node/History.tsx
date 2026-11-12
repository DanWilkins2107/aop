import type { EventView } from "../../../../src/shared/events/types.js";
import { describeEvent } from "../../lib/eventText.js";
import { timeAgo } from "../../lib/format.js";

export function History({ events, titleOf }: { events: EventView[]; titleOf: (id: string) => string }) {
  return (
    <ol className="history">
      {[...events].reverse().map((event) => (
        <li key={event.id}>
          <span className="history-text">{describeEvent(event, titleOf)}</span>
          <span className="muted history-time" title={event.created_at}>
            {event.actor}, {timeAgo(event.created_at)}
          </span>
        </li>
      ))}
    </ol>
  );
}
