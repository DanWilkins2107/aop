import type { EventView } from "../../../../src/shared/api.js";
import { describeEvent, timeAgo } from "../../lib/format.js";

export function History({ events, titleOf }: { events: EventView[]; titleOf: (id: string) => string }) {
  return (
    <section className="panel">
      <h2>History</h2>
      <ol className="history">
        {[...events].reverse().map((event) => (
          <li key={event.id}>
            <span className={`history-actor history-actor-${event.actor}`} title={event.actor} />
            <span className="history-text">{describeEvent(event, titleOf)}</span>
            <span className="muted history-time" title={event.created_at}>
              {timeAgo(event.created_at)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
