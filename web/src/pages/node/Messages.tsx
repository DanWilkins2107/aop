import { useState, type KeyboardEvent } from "react";
import type { MessageRow, NodeView } from "../../../../src/shared/api.js";
import { api } from "../../lib/api.js";
import { humanize, timeAgo, toTarget } from "../../lib/format.js";
import { useAction } from "./useAction.js";

/** The page's one message box. While the agent is waiting on a question, what's written here is the answer. */
function MessageBox({ node, asking, reload }: { node: NodeView; asking: boolean; reload: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction(reload);

  async function send() {
    if (body.trim() === "" || busy) return;
    if (await run(() => (asking ? api.answer(node.id, body) : api.addMessage(node.id, body)))) setBody("");
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void send();
  };
  const label = asking ? "Answer the question" : "Write a message";

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea rows={asking ? 3 : 2} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onKeyDown} placeholder={label} aria-label={label} />
      <div className="action-row">
        <button type="submit" className={asking ? "btn-primary" : undefined} disabled={busy || body.trim() === ""}>
          {asking ? toTarget("Answer", node.return_stage) : "Send"}
        </button>
        <span className="muted hint">Ctrl+Enter</span>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </form>
  );
}

export function Messages({
  node,
  messages,
  reload,
}: {
  node: NodeView;
  messages: MessageRow[];
  reload: () => Promise<void>;
}) {
  const asking = node.stage === "ask_human_question";
  return (
    <section className="panel" aria-label="Messages">
      <h2>Messages</h2>
      {/* Keyed so that a half-written message can't go out as an answer to a question that just arrived. */}
      <MessageBox key={asking ? "answer" : "message"} node={node} asking={asking} reload={reload} />
      {messages.length === 0 ? <p className="muted section-text">No messages yet.</p> : null}
      {[...messages].reverse().map((message) => (
        <article key={message.id} className={`message message-${message.author}`}>
          <div className="message-meta">
            <span className="message-author">{humanize(message.author)}</span>
            <span className="message-context" title={message.created_at}>
              {humanize(message.stage)} · {timeAgo(message.created_at)}
            </span>
          </div>
          <div className="message-body">{message.body}</div>
        </article>
      ))}
    </section>
  );
}
