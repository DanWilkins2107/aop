// The page's one event stream, and its connection status. Kept apart from the React hooks in
// `live.ts` and free of `window`, so it can be tested without a browser.

import { urls } from "./api.js";

export type Status = "connecting" | "live" | "offline";

const changeListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();
let status: Status = "connecting";
let source: EventSource | null = null;

/**
 * EventSource reports an error on every failed retry. Only a real change reaches listeners, so the
 * "Reconnecting" notice is announced once per outage rather than once per attempt.
 */
function setStatus(next: Status): void {
  if (next === status) return;
  status = next;
  for (const listener of statusListeners) listener();
}

/** One stream for the whole page. EventSource reconnects by itself after a server restart. */
function ensureConnected(): void {
  if (source) return;
  source = new EventSource(urls.events);
  const fire = () => {
    for (const listener of changeListeners) listener();
  };
  source.addEventListener("ready", () => {
    setStatus("live");
    fire();
  });
  source.addEventListener("change", fire);
  source.onerror = () => setStatus("offline");
}

/** Calls `listener` whenever the connection status changes. Returns the unsubscribe. */
export function subscribeLiveStatus(listener: () => void): () => void {
  ensureConnected();
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export const liveStatus = (): Status => status;

/** Calls `listener` whenever the server says something changed. Returns the unsubscribe. */
export function subscribeChanges(listener: () => void): () => void {
  ensureConnected();
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
