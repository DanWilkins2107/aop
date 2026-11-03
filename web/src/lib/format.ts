import type { EventView } from "../../../src/shared/api.js";

/** "split_proposed" to "Split proposed". Stage names come from config, so this is display only. */
export function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One line of history. `titleOf` names the other end of an edge. */
export function describeEvent(event: EventView, titleOf: (id: string) => string): string {
  const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as Record<string, unknown>;
  const from = humanize(text(data["from_stage"]));
  const to = humanize(text(data["to_stage"]));
  switch (event.kind) {
    case "node_created":
      return `Created at ${humanize(text(data["stage"]))}`;
    case "stage_changed":
      switch (data["via"]) {
        case "next":
          return `${humanize(text(data["outcome"]))}: ${from} → ${to}`;
        case "move":
          return `Moved by hand: ${from} → ${to}`;
        case "ask":
          return `Asked a question at ${from}`;
        case "answer":
          return `Answered, back to ${to}`;
        case "fail":
          return `Failed at ${from}${data["reason"] ? `: ${text(data["reason"])}` : ""}`;
        case "retry":
          return `Retried, back to ${to}`;
        case "invalidate":
          return `Invalidated at ${from}: ${text(data["reason"])}`;
        case "restore":
          return `Restored to ${to}`;
        default:
          return `${from} → ${to}`;
      }
    case "message_added":
      return `Message posted at ${humanize(text(data["stage"]))}`;
    case "description_edited":
      return "Description edited";
    case "link_added":
      return `${data["kind"] === "pr" ? "PR" : "Ticket"} linked: ${text(data["url"])}`;
    case "edge_added":
      return `${data["kind"] === "blocks" ? "Now blocks" : "Subtask added:"} ${titleOf(text(data["target_id"]))}`;
    case "edge_removed":
      return `${data["kind"] === "blocks" ? "No longer blocks" : "Subtask removed:"} ${titleOf(text(data["target_id"]))}`;
    default:
      return humanize(event.kind);
  }
}
