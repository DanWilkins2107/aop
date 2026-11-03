import { useState } from "react";
import type { LinkRow, NodeView } from "../../../../src/shared/api.js";
import { api, ApiFailure, failureText } from "../../lib/api.js";

function shorten(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}

export function Links({ node, links, reload }: { node: NodeView; links: LinkRow[]; reload: () => Promise<void> }) {
  const [kind, setKind] = useState<LinkRow["kind"]>("ticket");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.addLink(node.id, kind, url.trim());
      setUrl("");
      await reload();
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === "constraint_violation") setError("That link is already here.");
      else if (failure instanceof ApiFailure && failure.code === "bad_request") setError("Links must start with http:// or https://.");
      else setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Links</h2>
      {links.length === 0 ? <p className="muted">No links yet.</p> : null}
      <ul className="link-list">
        {links.map((link) => (
          <li key={link.id}>
            <span className={`link-kind link-kind-${link.kind}`}>{link.kind === "pr" ? "PR" : "Ticket"}</span>
            <a href={link.url} target="_blank" rel="noreferrer" title={link.url}>
              {shorten(link.url)}
            </a>
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <select value={kind} onChange={(e) => setKind(e.target.value as LinkRow["kind"])} aria-label="Link kind">
          <option value="ticket">Ticket</option>
          <option value="pr">PR</option>
        </select>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Link URL" />
        <button type="submit" className="btn-small" disabled={busy || url.trim() === ""}>
          Add
        </button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}
    </section>
  );
}
