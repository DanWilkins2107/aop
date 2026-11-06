import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { FOCUSABLE, wrappedFocus } from "../lib/focusTrap.js";

/** A modal form. Escape or a click outside closes it, unless `busy`. */
export function Dialog({
  title,
  busy,
  onClose,
  onSubmit,
  children,
  error,
  submitLabel,
  submitClass = "btn-primary",
  canSubmit = true,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
  error: string | null;
  submitLabel: string;
  submitClass?: string;
  canSubmit?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  // Focus starts inside, on the field a dialog autofocuses or else its first control, and goes back
  // to whatever opened the dialog when it closes, if that's still on the page.
  useEffect(() => {
    const opener = document.activeElement;
    const form = formRef.current;
    if (form && !form.contains(document.activeElement)) form.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      // Tab stays in the dialog, since the page behind it can't be used while it's open.
      const form = formRef.current;
      if (event.key !== "Tab" || !form) return;
      const focusable = [...form.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const next = wrappedFocus(focusable, active, event.shiftKey);
      if (next) {
        event.preventDefault();
        next.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit && !busy) onSubmit();
  };

  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        ref={formRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2>{title}</h2>
        {children}
        {error ? <div className="form-error">{error}</div> : null}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={submitClass} disabled={busy || !canSubmit}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
