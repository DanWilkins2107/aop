import { useState } from "react";
import type { NodeView } from "../../../../src/shared/api.js";
import { api, failureText } from "../../lib/api.js";

export function Description({ node, reload }: { node: NodeView; reload: () => Promise<void> }) {
  // Null until edited, so that live updates show through unless there's a draft to protect.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? node.body;
  const dirty = draft !== null && draft !== node.body;

  async function save() {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.editBody(node.id, draft);
      await reload();
      setDraft(null);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Description</h2>
      <textarea
        rows={Math.min(14, Math.max(4, value.split("\n").length + 1))}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="No description yet"
        aria-label="Description"
      />
      <div className="action-row">
        <button type="button" className="btn-primary btn-small" disabled={!dirty || busy} onClick={() => void save()}>
          Save
        </button>
        {dirty ? (
          <button type="button" className="btn-small" disabled={busy} onClick={() => setDraft(null)}>
            Discard
          </button>
        ) : null}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </section>
  );
}
