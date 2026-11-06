import { useId } from "react";
import { errorReference } from "../lib/formError.js";

/**
 * An id for a form's error, and the `aria-describedby` its fields should carry so a screen reader
 * reads the error with the field it's about.
 */
export function useFormError(error: string | null): { errorId: string; describedBy: string | undefined } {
  const errorId = useId();
  return { errorId, describedBy: errorReference(error, errorId) };
}

/** The error from a form or action. It's an alert, so it's announced as soon as it appears. */
export function FormError({ error, id }: { error: string | null; id?: string }) {
  return error ? (
    <div className="form-error" role="alert" id={id}>
      {error}
    </div>
  ) : null;
}
