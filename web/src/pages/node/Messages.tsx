import { useState, type KeyboardEvent } from "react";
import type { MessageRow, NodeView, StagesView } from "../../../../src/shared/api.js";
import { StagePill } from "../../components/StagePill.js";
import { api, failureText } from "../../lib/api.js";
import { timeAgo } from "../../lib/format.js";

export function Messages({
  node,
  messages,
  stages,
  reload,
}: {
  node: NodeView;
  messages: MessageRow[];
  stages: StagesView;
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
    <section className="panel">
      <h2>Messages</h2>
      {messages.length === 0 ? <p className="muted">No messages yet.</p> : null}
      {messages.map((message) => (
        <article key={message.id} className="message">
          <div className="message-meta">
            <span className={`role role-${message.author}`}>{message.author}</span>
            <StagePill stage={message.stage} stages={stages} />
            <span className="muted" title={message.created_at}>
              {timeAgo(message.created_at)}
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
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Write a message"
          aria-label="Write a message"
        />
        <div className="action-row">
          <button type="submit" className="btn-primary btn-small" disabled={busy || body.trim() === ""}>
            Send
          </button>
          <span className="muted hint">Ctrl+Enter</span>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
      </form>
    </section>
  );
}
