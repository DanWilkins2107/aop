// The page's one event stream, and its connection status. Kept apart from the React hooks in
// `live.ts` and free of `window`, so it can be tested without a browser.

import { urls } from "./api.js";
import { type ChangeNotice, readNotice } from "./changes.js";

export type Status = "connecting" | "live" | "offline";

/** Each hears a change notice, or null on connecting, when anything may have changed. */
const changeListeners = new Set<(notice: ChangeNotice | null) => void>();
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
  const fire = (notice: ChangeNotice | null) => {
    for (const listener of changeListeners) listener(notice);
  };
  // Changes may have been missed while away, so every page reloads in full.
  source.addEventListener("ready", () => {
    setStatus("live");
    fire(null);
  });
  source.addEventListener("change", (event) => fire(readNotice((event as MessageEvent).data)));
  source.onerror = () => setStatus("offline");
}

/** Calls `listener` whenever the connection status changes. Returns the unsubscribe. */
export function subscribeLiveStatus(listener: () => void): () => void {
  ensureConnected();
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export const liveStatus = (): Status => status;

/** Calls `listener` with what the server says changed, or null on connecting. Returns the unsubscribe. */
export function subscribeChanges(listener: (notice: ChangeNotice | null) => void): () => void {
  ensureConnected();
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
