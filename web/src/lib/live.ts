import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiFailure } from "./api.js";

type Status = "connecting" | "live" | "offline";

const REFETCH_DELAY_MS = 80;

const changeListeners = new Set<() => void>();
const statusListeners = new Set<() => void>();
let status: Status = "connecting";
let source: EventSource | null = null;

function setStatus(next: Status): void {
  status = next;
  for (const listener of statusListeners) listener();
}

/** One stream for the whole page. EventSource reconnects by itself after a server restart. */
function ensureConnected(): void {
  if (source) return;
  source = new EventSource("/api/events");
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

export function useLiveStatus(): Status {
  return useSyncExternalStore(
    (listener) => {
      ensureConnected();
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    () => status,
  );
}

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  reload: () => Promise<void>;
}

/**
 * An invalid `stages.yaml` must replace the page, because old data would hide that nothing works.
 * So must a project or node that has been deleted.
 */
const dropsOldData = (error: unknown) =>
  error instanceof ApiFailure && (error.code === "config_invalid" || error.code === "not_found");

/**
 * Loads data, then loads it again whenever the server reports a change or the window regains
 * focus (which also picks up edits to `stages.yaml`). Old data stays on screen during a refetch.
 */
export function useLiveData<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: unknown }>({
    key,
    data: null,
    error: null,
  });
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const data = await loader.current();
      if (request === latest.current) setState({ key, data, error: null });
    } catch (error) {
      if (request !== latest.current) return;
      setState((previous) => ({
        key,
        data: previous.key === key && !dropsOldData(error) ? previous.data : null,
        error,
      }));
    }
  }, [key]);

  useEffect(() => {
    void reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), REFETCH_DELAY_MS);
    };
    ensureConnected();
    changeListeners.add(soon);
    window.addEventListener("focus", soon);
    return () => {
      clearTimeout(timer);
      changeListeners.delete(soon);
      window.removeEventListener("focus", soon);
    };
  }, [reload]);

  const current = state.key === key ? state : { data: null, error: null };
  return { data: current.data, error: current.error, reload };
}
