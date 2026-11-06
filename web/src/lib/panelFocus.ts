// Keeping keyboard focus in a panel whose contents are rebuilt, such as Moving on when the stage changes.

/** Where focus went when it left an element inside the panel. */
export type FocusMove = "inside" | "outside" | "nowhere";

/**
 * Whether the panel should still count as holding focus after focus left `from`. Moving within the
 * panel keeps it, and moving to something else gives it up. Going nowhere keeps it only when `from`
 * was taken away (removed, or disabled while its action runs), not when the user clicked off it.
 */
export function stillHoldsFocus(to: FocusMove, from: { isConnected: boolean; disabled?: boolean }): boolean {
  if (to === "inside") return true;
  if (to === "outside") return false;
  return !from.isConnected || from.disabled === true;
}

/** Focus has dropped to the top of the page, so nothing would stop the panel taking it back. */
export function focusIsLost(active: unknown, body: unknown): boolean {
  return active === null || active === body;
}

/** What the panel's polite status region says after a live stage change. */
export function stageChangeNotice(stageLabel: string): string {
  return `Stage changed to ${stageLabel}`;
}
