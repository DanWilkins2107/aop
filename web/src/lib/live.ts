// Live data. One event stream per page, and `useLiveData` refetches whenever the server says something
// it shows has changed.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiFailure } from "./api.js";
import { type ChangeNotice, mergeNotices } from "./changes.js";
import { liveStatus, subscribeChanges, subscribeLiveStatus, type Status } from "./liveStream.js";

const REFETCH_DELAY_MS = 80;

export function useLiveStatus(): Status {
  return useSyncExternalStore(subscribeLiveStatus, liveStatus);
}

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  reload: () => Promise<void>;
}

/** Passed to a loader on a refetch: the data on screen, and what changed since it was loaded. */
export interface Refresh<T> {
  previous: T;
  change: ChangeNotice;
}

export interface LiveOptions<T> {
  /**
   * Whether a change concerns this page, given the data on screen (null before the first load). Without
   * it, every change does.
   */
  affects?: (notice: ChangeNotice, data: T | null) => boolean;
}

/**
 * An invalid `stages.yaml` must replace the page, because old data would hide that nothing works.
 * So must a project or node that has been deleted.
 */
const dropsOldData = (error: unknown) =>
  error instanceof ApiFailure && (error.code === "config_invalid" || error.code === "not_found");

/**
 * Loads data, then loads it again whenever the server reports a change that `affects` it, or the window
 * regains focus (which also picks up edits to `stages.yaml`). Old data stays on screen during a refetch.
 * A loader can use the `Refresh` it's given to read again only what the change could have touched.
 */
export function useLiveData<T>(
  load: (refresh: Refresh<T> | null) => Promise<T>,
  key: string,
  options: LiveOptions<T> = {},
): Loaded<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: unknown }>({
    key,
    data: null,
    error: null,
  });
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const affects = useRef(options.affects);
  affects.current = options.affects;
  const current = state.key === key ? state : { data: null, error: null };
  const shown = useRef<T | null>(null);
  shown.current = current.data;

  // Every change the data on screen hasn't caught up with, null meaning a full load. A refetch that's
  // overtaken by another hands what it was asked for on, so the later one can't skip it.
  const owed = useRef<{ change: ChangeNotice | null } | null>(null);

  const fetchData = useCallback(
    async (change: ChangeNotice | null) => {
      const request = ++latest.current;
      const before = owed.current;
      const asked =
        before === null ? change : before.change === null || change === null ? null : mergeNotices(before.change, change);
      owed.current = { change: asked };
      const previous = shown.current;
      try {
        const data = await loader.current(asked !== null && previous !== null ? { previous, change: asked } : null);
        if (request === latest.current) {
          owed.current = null;
          setState({ key, data, error: null });
        }
      } catch (error) {
        if (request !== latest.current) return;
        setState((before) => ({
          key,
          data: before.key === key && !dropsOldData(error) ? before.data : null,
          error,
        }));
      }
    },
    [key],
  );
  const reload = useCallback(() => fetchData(null), [fetchData]);

  useEffect(() => {
    void fetchData(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // What changed since the refetch was scheduled, or null for a full reload. Null when none is.
    let pending: { change: ChangeNotice | null } | null = null;
    const soon = (notice: ChangeNotice | null) => {
      const before = pending;
      const change =
        before === null ? notice : before.change === null || notice === null ? null : mergeNotices(before.change, notice);
      pending = { change };
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending = null;
        void fetchData(change);
      }, REFETCH_DELAY_MS);
    };
    const onChange = (notice: ChangeNotice | null) => {
      if (notice === null || affects.current === undefined || affects.current(notice, shown.current)) soon(notice);
    };
    const onFocus = () => soon(null);
    const unsubscribe = subscribeChanges(onChange);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchData]);

  return { data: current.data, error: current.error, reload };
}
