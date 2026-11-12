import type { EventView } from "../../../src/shared/events/types.js";
import type { MessageRow } from "../../../src/shared/nodes/types.js";
import { stageChangeNote } from "./eventText.js";

/** A message, or a line from AOP about a stage change the messages wouldn't explain. */
export type VisitEntry = { kind: "message"; message: MessageRow } | { kind: "note"; id: string; at: string; text: string };

/** One continuous stay in a stage. Newest entries first. */
export interface StageVisit {
  stage: string;
  entries: VisitEntry[];
}

/**
 * Groups messages into the visits they were written in, newest visit first. Visits with nothing
 * to show are left out. A stage change worth a note (see `stageChangeNote`) opens the visit it
 * leads into.
 *
 * Reads the event log's own order rather than timestamps, because a stage change and the message
 * that goes with it can share a millisecond. A move that keeps the stage name, such as a change of
 * type, doesn't start a new visit, because the node never left.
 */
export function messageVisits(events: EventView[], messages: MessageRow[]): StageVisit[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const visits: StageVisit[] = [];

  const enter = (stage: string): StageVisit => {
    const current = visits.at(-1);
    if (current?.stage === stage) return current;
    const visit: StageVisit = { stage, entries: [] };
    visits.push(visit);
    return visit;
  };

  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    if (event.kind === "node_created" && typeof data["stage"] === "string") {
      enter(data["stage"]);
    } else if (event.kind === "stage_changed") {
      if (typeof data["from_stage"] === "string") enter(data["from_stage"]);
      if (typeof data["to_stage"] === "string") {
        const visit = enter(data["to_stage"]);
        const note = stageChangeNote(event);
        if (note !== null) visit.entries.push({ kind: "note", id: event.id, at: event.created_at, text: note });
      }
    } else if (event.kind === "message_added") {
      const message = byId.get(String(data["message_id"]));
      if (message) {
        enter(message.stage).entries.push({ kind: "message", message });
        byId.delete(message.id);
      }
    }
  }

  // Messages and events load separately, so a message can arrive just ahead of its event.
  for (const message of byId.values()) enter(message.stage).entries.push({ kind: "message", message });

  return visits
    .filter((visit) => visit.entries.length > 0)
    .map((visit) => ({ stage: visit.stage, entries: [...visit.entries].reverse() }))
    .reverse();
}
