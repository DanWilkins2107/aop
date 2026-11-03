import { useState } from "react";
import { failureText } from "../../lib/api.js";

/** Runs one action at a time and keeps its error on screen. */
export function useAction(reload: () => Promise<void>) {
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
      setError(failureText(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
