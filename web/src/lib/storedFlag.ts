import { useState } from "react";

/** An on/off view preference, remembered in this browser under `key`. */
export function useStoredFlag(key: string) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const change = (next: boolean) => {
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Only a convenience: the toggle still works until the page reloads.
    }
    setOn(next);
  };
  return [on, change] as const;
}
