/** What Tab can reach inside a modal. Disabled controls drop out, as they do for the browser. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab should go so that it stays inside a modal: from the last control round to the first,
 * Shift+Tab the other way, and back in from anywhere outside. Null leaves the move to the browser.
 */
export function wrappedFocus<T>(focusable: readonly T[], active: T | null, backwards: boolean): T | null {
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return null;
  const index = active === null ? -1 : focusable.indexOf(active);
  if (index === -1) return backwards ? last : first;
  if (backwards && index === 0) return last;
  if (!backwards && index === focusable.length - 1) return first;
  return null;
}
