import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { EventView } from "../../../../src/shared/events/types.js";
import type { MessageRow, NodeView } from "../../../../src/shared/nodes/types.js";
import type { StagesView } from "../../../../src/shared/stages/types.js";
import { CaptureImprovement } from "../../components/CaptureImprovement.js";
import { api } from "../../lib/api.js";
import { FormError, useFormError } from "../../components/FormError.js";
import { messageVisits, type StageVisit, type VisitEntry } from "../../lib/messageVisits.js";
import { humanize, timeAgo, toTarget } from "../../lib/format.js";
import { accentOf, stageColor } from "../../lib/stageStyle.js";
import { useAction } from "../../lib/useAction.js";

/** The page's one message box. While the agent is waiting on a question, what's written here is the answer. */
function MessageBox({ node, asking, reload }: { node: NodeView; asking: boolean; reload: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction(reload);
  const { errorId, describedBy } = useFormError(error);

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
      <textarea rows={asking ? 3 : 2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={label} aria-label={label} aria-describedby={describedBy} />
      <div className="action-row">
        <button type="submit" disabled={busy || body.trim() === ""}>
          {asking ? toTarget("Answer", node.return_stage) : "Send"}
        </button>
      </div>
      <FormError error={error} id={errorId} />
    </form>
  );
}

const entryId = (entry: VisitEntry) => (entry.kind === "message" ? entry.message.id : entry.id);

/** One continuous visit to a stage, its entries newest first. */
function Visit({
  visit,
  stages,
  hash,
  canCapture,
  capturing,
  setCapturing,
}: {
  visit: StageVisit;
  stages: StagesView;
  hash: string;
  canCapture: boolean;
  capturing: string | null;
  setCapturing: (id: string | null) => void;
}) {
  return (
    <section
      className="visit"
      aria-label={`Messages in ${humanize(visit.stage)}`}
      data-stage={visit.stage}
      style={{ borderLeftColor: accentOf(stageColor(visit.stage, stages)) }}
    >
      <h3 className="visit-stage">{humanize(visit.stage)}</h3>
      {visit.entries.map((entry) => {
        if (entry.kind === "note") {
          return (
            <p key={entry.id} className="message-note" title={entry.at}>
              {entry.text} · {timeAgo(entry.at)}
            </p>
          );
        }
        const { message } = entry;
        return (
          <article
            key={message.id}
            id={`m-${message.id}`}
            className={`message message-${message.author}${`#m-${message.id}` === hash ? " message-target" : ""}`}
          >
            <div className="message-meta">
              <span className="message-author">{humanize(message.author)}</span>
              <span className="message-context" title={message.created_at}>
                {timeAgo(message.created_at)}
              </span>
              {canCapture ? (
                <button
                  type="button"
                  className="btn-quiet message-capture"
                  aria-label="Add an improvement from this message"
                  title="Add an improvement from this message"
                  aria-expanded={capturing === message.id}
                  onClick={() => setCapturing(capturing === message.id ? null : message.id)}
                >
                  +
                </button>
              ) : null}
            </div>
            <div className="message-body">{message.body}</div>
            {capturing === message.id ? (
              <CaptureImprovement key={message.id} sourceMessageId={message.id} onClose={() => setCapturing(null)} />
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

/**
 * Every message in one outer card, under the single message box. Inside it, one card per
 * continuous visit to a stage, newest visit first, each holding that visit's messages newest
 * first. The inner card carries the stage, so the messages themselves only show who wrote them.
 * A stage change the messages wouldn't explain sits among them as a small centred note.
 */
export function Messages({
  node,
  messages,
  events,
  stages,
  reload,
}: {
  node: NodeView;
  messages: MessageRow[];
  events: EventView[];
  stages: StagesView;
  reload: () => Promise<void>;
}) {
  const asking = node.stage === "ask_human_question";
  const visits = messageVisits(events, messages);
  // Improvements come from project work, so an improvement's own messages have no +.
  const canCapture = node.kind === "work";
  const [capturing, setCapturing] = useState<string | null>(null);
  const { hash } = useLocation();

  // "From:" on an improvement links here, to one message.
  const hasTarget = messages.some((m) => `#m-${m.id}` === hash);
  useEffect(() => {
    if (hasTarget) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [hash, hasTarget]);

  const render = (visit: StageVisit) => (
    <Visit
      // A visit's oldest entry never changes, so it keys the card steadily as new ones arrive.
      key={entryId(visit.entries.at(-1)!)}
      visit={visit}
      stages={stages}
      hash={hash}
      canCapture={canCapture}
      capturing={capturing}
      setCapturing={setCapturing}
    />
  );

  return (
    <section className="panel messages" aria-label="Messages">
      <h2>Messages</h2>
      {/* Keyed so that a half-written message can't go out as an answer to a question that just arrived. */}
      <MessageBox key={asking ? "answer" : "message"} node={node} asking={asking} reload={reload} />
      {visits.length === 0 ? <p className="muted section-text">No messages yet.</p> : null}
      {visits.map(render)}
    </section>
  );
}
