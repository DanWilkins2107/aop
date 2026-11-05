import { useState } from "react";
import type { MessageRow, NodeView, StagesView } from "../../../../src/shared/api.js";
import { api } from "../../lib/api.js";
import { humanize, timeAgo, toTarget } from "../../lib/format.js";
import { accentOf, stageColor } from "../../lib/stageStyle.js";
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

/**
 * Every message in one card, newest first. A bar in the colour of the stage each was written in
 * shows the stages at a glance, and names the stage for anyone who can't tell the colours apart.
 */
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
  const asking = node.stage === "ask_human_question";
  return (
    <section className="panel messages" aria-label="Messages">
      <h2>Messages</h2>
      {/* Keyed so that a half-written message can't go out as an answer to a question that just arrived. */}
      <MessageBox key={asking ? "answer" : "message"} node={node} asking={asking} reload={reload} />
      {messages.length === 0 ? <p className="muted section-text">No messages yet.</p> : null}
      {[...messages].reverse().map((message) => {
        const written = `Written in ${humanize(message.stage)}`;
        return (
          <article key={message.id} className={`message message-${message.author}`} data-stage={message.stage}>
            <span
              className="message-bar"
              role="img"
              aria-label={written}
              title={written}
              style={{ color: accentOf(stageColor(message.stage, stages)) }}
            />
            <div className="message-meta">
              <span className="message-author">{humanize(message.author)}</span>
              <span className="message-context" title={message.created_at}>
                {timeAgo(message.created_at)}
              </span>
            </div>
            <div className="message-body">{message.body}</div>
          </article>
        );
      })}
    </section>
  );
}
