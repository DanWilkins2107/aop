import { useState } from "react";
import type { NodeView } from "../../../../src/shared/api/types.js";
import { FormError, useFormError } from "../../components/FormError.js";
import { api } from "../../lib/api.js";
import { useAction } from "../../lib/useAction.js";

export function Description({ node, reload }: { node: NodeView; reload: () => Promise<void> }) {
  // Null while reading, so that live updates show through unless there's a draft to protect.
  const [draft, setDraft] = useState<string | null>(null);
  const { busy, error, run } = useAction(reload);
  const { errorId, describedBy } = useFormError(error);

  async function save() {
    if (draft === null) return;
    if (await run(() => api.editBody(node.id, draft))) setDraft(null);
  }

  return (
    <section className="panel" aria-label="Description">
      <div className="section-head">
        <h2>Description</h2>
        {draft === null ? (
          <button type="button" className="btn-quiet" onClick={() => setDraft(node.body)}>
            Edit
          </button>
        ) : null}
      </div>
      {draft === null ? (
        node.body === "" ? (
          <p className="muted section-text">No description yet.</p>
        ) : (
          <p className="prose section-text">{node.body}</p>
        )
      ) : (
        <>
          <textarea
            autoFocus
            rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Description"
            aria-describedby={describedBy}
          />
          <div className="action-row">
            <button type="button" disabled={busy || draft === node.body} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      <FormError error={error} id={errorId} />
    </section>
  );
}
