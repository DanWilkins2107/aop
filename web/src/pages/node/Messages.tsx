import { useState } from "react";
import type { EventView, MessageRow, NodeView } from "../../../../src/shared/api.js";
import { api } from "../../lib/api.js";
import { humanize, timeAgo, toTarget } from "../../lib/format.js";
import { messageVisits } from "../../lib/messageVisits.js";
import { useAction } from "./useAction.js";

/** The page's one message box. While the agent is waiting on a question, what's written here is the answer. */
function MessageBox({ node, asking, reload }: { node: NodeView; asking: boolean; reload: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction(reload);

  async function send() {
    if (body.trim() === "" || busy) return;
    if (await run(() => (asking ? api.answer(node.id, body) : api.addMessage(node.id, body)))) setBody("");
  }

  const label = asking ? "Answer the question" : "Write a message";

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea rows={asking ? 3 : 2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={label} aria-label={label} />
      <div className="action-row">
        <button type="submit" className="btn-small" disabled={busy || body.trim() === ""}>
          {asking ? toTarget("Answer", node.return_stage) : "Send"}
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </form>
  );
}

export function Messages({
  node,
  messages,
  events,
  reload,
}: {
  node: NodeView;
  messages: MessageRow[];
  events: EventView[];
  reload: () => Promise<void>;
}) {
  const asking = node.stage === "ask_human_question";
  return (
    <section className="messages" aria-label="Messages">
      <div className="panel">
        <h2>Messages</h2>
        {/* Keyed so that a half-written message can't go out as an answer to a question that just arrived. */}
        <MessageBox key={asking ? "answer" : "message"} node={node} asking={asking} reload={reload} />
        {messages.length === 0 ? <p className="muted section-text">No messages yet.</p> : null}
      </div>
      {messageVisits(events, messages).map((visit) => (
        <section key={visit.messages.at(-1)?.id} className="panel visit" aria-label={`Messages in ${humanize(visit.stage)}`}>
          <h3>{humanize(visit.stage)}</h3>
          {visit.messages.map((message) => (
            <article key={message.id} className={`message message-${message.author}`}>
              <div className="message-meta">
                <span className="message-author">{humanize(message.author)}</span>
                <span className="message-context" title={message.created_at}>
                  {timeAgo(message.created_at)}
                </span>
              </div>
              <div className="message-body">{message.body}</div>
            </article>
          ))}
        </section>
      ))}
    </section>
  );
}
