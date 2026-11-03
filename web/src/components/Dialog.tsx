import { useEffect, type FormEvent, type ReactNode } from "react";

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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
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
