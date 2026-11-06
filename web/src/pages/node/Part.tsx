import type { ReactNode } from "react";

/** A small collapsible part of a card, usually closed until wanted. `status` keeps its state readable while closed. */
export function Part({ title, status, defaultOpen, children }: { title: string; status?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="detail-part" open={defaultOpen}>
      <summary>
        {title}
        {status !== undefined ? <span className="detail-status">{status}</span> : null}
      </summary>
      <div className="detail-body">{children}</div>
    </details>
  );
}
