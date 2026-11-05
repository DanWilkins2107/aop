import { useState } from "react";
import { failureText } from "./api.js";

const nothingToReload = async () => {};

/**
 * Runs one action at a time and keeps its error on screen. `reload` runs after a success, and
 * `describe` turns a failure into the text to show.
 */
export function useAction(
  reload: () => Promise<void> = nothingToReload,
  describe: (failure: unknown) => string = failureText,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (failure) {
      setError(describe(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
