import type { EventView, MessageRow } from "../../../src/shared/api.js";

/** One continuous stay in a stage. Newest messages first. */
export interface StageVisit {
  stage: string;
  messages: MessageRow[];
}

/**
 * Groups messages into the visits they were written in, newest visit first. Visits with no
 * messages are left out.
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
    const visit: StageVisit = { stage, messages: [] };
    visits.push(visit);
    return visit;
  };

  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    if (event.kind === "node_created" && typeof data["stage"] === "string") {
      enter(data["stage"]);
    } else if (event.kind === "stage_changed") {
      if (typeof data["from_stage"] === "string") enter(data["from_stage"]);
      if (typeof data["to_stage"] === "string") enter(data["to_stage"]);
    } else if (event.kind === "message_added") {
      const message = byId.get(String(data["message_id"]));
      if (message) {
        enter(message.stage).messages.push(message);
        byId.delete(message.id);
      }
    }
  }

  // Messages and events load separately, so a message can arrive just ahead of its event.
  for (const message of byId.values()) enter(message.stage).messages.push(message);

  return visits
    .filter((visit) => visit.messages.length > 0)
    .map((visit) => ({ stage: visit.stage, messages: [...visit.messages].reverse() }))
    .reverse();
}
