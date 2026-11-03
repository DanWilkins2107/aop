import { useState, type KeyboardEvent } from "react";
import type { MessageRow, NodeView } from "../../../../src/shared/api.js";
import { api, failureText } from "../../lib/api.js";
import { humanize, timeAgo } from "../../lib/format.js";

export function Messages({
  node,
  messages,
  reload,
}: {
  node: NodeView;
  messages: MessageRow[];
  reload: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (body.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addMessage(node.id, body);
      setBody("");
      await reload();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void send();
  };

  return (
    <section className="section">
      <h2>Messages</h2>
      {messages.length === 0 ? <p className="muted section-text">No messages yet.</p> : null}
      {messages.map((message) => (
        <article key={message.id} className="message">
          <div className="message-meta">
            <span className="message-author">{humanize(message.author)}</span>
            <span className="muted" title={message.created_at}>
              {humanize(message.stage)} · {timeAgo(message.created_at)}
            </span>
          </div>
          <div className="message-body">{message.body}</div>
        </article>
      ))}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Write a message"
          aria-label="Write a message"
        />
        <div className="action-row">
          <button type="submit" disabled={busy || body.trim() === ""}>
            Send
          </button>
          <span className="muted hint">Ctrl+Enter</span>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
      </form>
    </section>
  );
}
