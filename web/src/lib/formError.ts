/**
 * What a field's `aria-describedby` should be so that it points at the form's error while one is
 * shown, and at nothing otherwise (a dangling reference would read as nothing, or as stale text).
 */
export function errorReference(error: string | null, errorId: string): string | undefined {
  return error ? errorId : undefined;
}
