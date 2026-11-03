import { useState } from "react";
import type { EventView, MessageRow, NodeView, StagesView } from "../../../../src/shared/api.js";
import { Dialog } from "../../components/Dialog.js";
import { api, failureText } from "../../lib/api.js";
import { readableText } from "../../lib/color.js";
import { humanize, stageOptionGroups } from "../../lib/format.js";
import { FINISHED_STAGES, targetColor } from "../../lib/stageStyle.js";

/** Runs one action at a time and keeps its error on screen. */
function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (failure) {
      setError(failureText(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** The reason given when the node last entered this stage through its own action. */
function entryReason(events: EventView[], via: string): string | null {
  const event = [...events].reverse().find((e) => {
    const data = e.data as Record<string, unknown>;
    return e.kind === "stage_changed" && data["via"] === via;
  });
  const reason = (event?.data as Record<string, unknown> | undefined)?.["reason"];
  return typeof reason === "string" ? reason : null;
}

function AnswerForm({ node, messages, reload }: { node: NodeView; messages: MessageRow[]; reload: () => Promise<void> }) {
  const [answer, setAnswer] = useState("");
  const { busy, error, run } = useAction(reload);
  const question = [...messages].reverse().find((m) => m.stage === "ask_human_question" && m.author === "agent");
  return (
    <form
      className="answer-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => api.answer(node.id, answer));
      }}
    >
      <div className="question">{question?.body ?? "The agent asked a question."}</div>
      <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" aria-label="Your answer" />
      <div className="action-row">
        <button type="submit" className="btn-primary" disabled={busy || answer.trim() === ""}>
          Send answer
        </button>
        {node.return_stage ? <span className="muted">Returns to {humanize(node.return_stage)}.</span> : null}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </form>
  );
}

function RetryPanel({ node, events, reload }: { node: NodeView; events: EventView[]; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction(reload);
  const reason = entryReason(events, "fail");
  return (
    <div>
      <p className="action-text">
        <strong>The agent stopped without finishing.</strong> {reason}
      </p>
      <div className="action-row">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(() => api.retry(node.id))}>
          Retry
        </button>
        {node.return_stage ? <span className="muted">Returns to {humanize(node.return_stage)}.</span> : null}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

function UnblockPanel({ node, events, reload }: { node: NodeView; events: EventView[]; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction(reload);
  return (
    <div>
      <p className="action-text">
        <strong>Waiting on something outside AOP.</strong> {entryReason(events, "block")}
      </p>
      <div className="action-row">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(() => api.unblock(node.id))}>
          Unblock
        </button>
        {node.return_stage ? <span className="muted">Returns to {humanize(node.return_stage)}.</span> : null}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

function RestorePanel({ node, reload }: { node: NodeView; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction(reload);
  return (
    <div>
      <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(() => api.restore(node.id))}>
        Restore
      </button>
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

function Outcomes({ node, stages, reload }: { node: NodeView; stages: StagesView; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction(reload);
  const human = node.turn === "human";
  return (
    <div>
      {!human ? <p className="action-text muted">Agent's turn. Taking an outcome here stands in for the agent.</p> : null}
      <div className="action-row">
        {node.available_outcomes.map(({ outcome, target }) => {
          const background = targetColor(target, stages);
          return (
            <button
              key={outcome}
              type="button"
              className={`btn-outcome${human ? " btn-outcome-human" : ""}`}
              style={{ background, borderColor: background, color: readableText(background) }}
              disabled={busy}
              onClick={() => void run(() => api.next(node.id, outcome))}
            >
              {humanize(outcome)} <span className="btn-outcome-target">→ {humanize(target)}</span>
            </button>
          );
        })}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

/** What the current stage asks for. Stages without their own action get a line saying so. */
function Primary({
  node,
  stages,
  messages,
  events,
  reload,
}: {
  node: NodeView;
  stages: StagesView;
  messages: MessageRow[];
  events: EventView[];
  reload: () => Promise<void>;
}) {
  if (!node.stage_exists) return <p className="action-text">Outcomes are off until this node is moved to a stage that exists.</p>;
  if (node.stage === "ask_human_question") return <AnswerForm node={node} messages={messages} reload={reload} />;
  if (node.stage === "failed") return <RetryPanel node={node} events={events} reload={reload} />;
  if (node.stage === "externally_blocked") return <UnblockPanel node={node} events={events} reload={reload} />;
  if (node.stage === "invalidated") return <RestorePanel node={node} reload={reload} />;
  if (node.stage === "splitting") {
    return (
      <p className="action-text muted">
        An agent is creating children, which stay held until it finishes the split. Moving this node by hand ends the
        split and releases them.
      </p>
    );
  }
  if (node.stage === "scheduled") {
    return (
      <p className="action-text">
        Stays here and creates a child each time it fires. Schedule: <code>{node.cron}</code>
      </p>
    );
  }
  if (FINISHED_STAGES.includes(node.stage)) {
    return (
      <p className="action-text muted">
        {node.stage === "broken_down" ? "Finished. The work continues in the children." : "Finished."}
      </p>
    );
  }
  if (node.available_outcomes.length > 0) return <Outcomes node={node} stages={stages} reload={reload} />;
  return <p className="action-text muted">This stage has no outcomes. It moves on by itself, or by hand.</p>;
}

function InvalidateButton({ node, reload }: { node: NodeView; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction(reload);
  return (
    <>
      <button type="button" className="btn-danger-outline" onClick={() => setOpen(true)}>
        Invalidate…
      </button>
      {open ? (
        <Dialog
          title="Invalidate this node"
          busy={busy}
          onClose={() => setOpen(false)}
          onSubmit={() => void run(() => api.invalidate(node.id, reason.trim())).then((ok) => ok && setOpen(false))}
          error={error}
          submitLabel="Invalidate"
          submitClass="btn-danger"
          canSubmit={reason.trim() !== ""}
        >
          <p className="field-hint">Its descendants will read as invalidated by parent. It can be restored later.</p>
          <label>
            Reason
            <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this no longer valid?" />
          </label>
        </Dialog>
      ) : null}
    </>
  );
}

function BlockButton({ node, reload }: { node: NodeView; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction(reload);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Mark externally blocked…
      </button>
      {open ? (
        <Dialog
          title="Mark externally blocked"
          busy={busy}
          onClose={() => setOpen(false)}
          onSubmit={() => void run(() => api.block(node.id, reason.trim())).then((ok) => ok && setOpen(false))}
          error={error}
          submitLabel="Mark blocked"
          canSubmit={reason.trim() !== ""}
        >
          <p className="field-hint">
            No agent starts here until you unblock it, and anything it blocks stays blocked. Unblocking returns it to{" "}
            {humanize(node.stage)}.
          </p>
          <label>
            Reason
            <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is it waiting on?" />
          </label>
        </Dialog>
      ) : null}
    </>
  );
}

/** Who holds the claim. Only a human's can be released here: an agent's ends with its run. */
function ClaimRow({ node, reload }: { node: NodeView; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction(reload);
  if (node.claimed_by === null) return null;
  return (
    <div className="claim-row" data-claimed-by={node.claimed_by}>
      {node.claimed_by === "human" ? (
        <>
          <span>
            <strong>Claimed by a human.</strong> No agent starts here until it's released.
          </span>
          <button type="button" className="btn-small" disabled={busy} onClick={() => void run(() => api.release(node.id))}>
            Release claim
          </button>
        </>
      ) : (
        <span>
          <strong>An agent run holds this node.</strong> The claim ends with the run.
        </span>
      )}
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

/** The stages a human can send a node to. Other built-ins have their own actions. */
function moveChoices(stages: StagesView): { group: string; options: { label: string; value: string }[] }[] {
  return [
    ...stageOptionGroups(stages),
    {
      group: "Finish",
      options: FINISHED_STAGES.map((stage) => ({ label: humanize(stage), value: JSON.stringify({ stage }) })),
    },
  ];
}

function HumanMove({ node, stages, reload }: { node: NodeView; stages: StagesView; reload: () => Promise<void> }) {
  const [choice, setChoice] = useState("");
  const [cron, setCron] = useState("");
  const { busy, error, run } = useAction(reload);
  const parsed = choice ? (JSON.parse(choice) as { stage: string; type?: string }) : null;
  const toScheduled = parsed?.stage === "scheduled";
  const needsCron = toScheduled && node.cron === null;

  return (
    <details className="human-move" open={!node.stage_exists}>
      <summary>Move by hand</summary>
      <form
        className="human-move-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!parsed) return;
          const body = toScheduled && cron.trim() !== "" ? { ...parsed, cron: cron.trim() } : parsed;
          void run(() => api.move(node.id, body)).then((ok) => {
            if (ok) {
              setChoice("");
              setCron("");
            }
          });
        }}
      >
        <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Stage to move to">
          <option value="">Choose a stage…</option>
          {moveChoices(stages).map(({ group, options }) => (
            <optgroup key={group} label={group}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {toScheduled ? (
          <input
            className="mono"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder={node.cron ?? "0 3 * * *"}
            aria-label="Cron schedule"
          />
        ) : null}
        <button type="submit" disabled={busy || !parsed || (needsCron && cron.trim() === "")}>
          Move
        </button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}
    </details>
  );
}

export function Actions(props: {
  node: NodeView;
  stages: StagesView;
  messages: MessageRow[];
  events: EventView[];
  reload: () => Promise<void>;
}) {
  const { node, stages, reload } = props;
  const canBlock = !["done", "broken_down", "invalidated", "externally_blocked"].includes(node.stage);
  return (
    <>
    <ClaimRow node={node} reload={reload} />
    <div className="actions">
      {/* Keyed by stage so that a half-typed answer can't carry over to the next stage. */}
      <div className="actions-primary" key={node.stage}>
        <Primary {...props} />
      </div>
      <div className="actions-secondary">
        {canBlock ? <BlockButton node={node} reload={reload} /> : null}
        {node.stage !== "invalidated" ? <InvalidateButton node={node} reload={reload} /> : null}
        <HumanMove node={node} stages={stages} reload={reload} />
      </div>
    </div>
    </>
  );
}
