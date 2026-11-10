import { Fragment, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import type { EventView, NodeView, ProposalView, StagesView } from "../../../../src/shared/api.js";
import { FINISHED_STAGES } from "../../../../src/shared/builtInStages.js";
import { FormError } from "../../components/FormError.js";
import { api, urls } from "../../lib/api.js";
import { humanize, toTarget } from "../../lib/format.js";
import { focusIsLost, stageChangeNotice, stillHoldsFocus } from "../../lib/panelFocus.js";
import { useAction } from "../../lib/useAction.js";
import { MoveForm } from "./MoveForm.js";
import { ScheduleEditor } from "./ScheduleEditor.js";

type Reload = () => Promise<void>;

/** The reason given when the node last entered this stage through its own action. */
function entryReason(events: EventView[], via: string): string | null {
  const event = [...events].reverse().find((e) => {
    const data = e.data as Record<string, unknown>;
    return e.kind === "stage_changed" && data["via"] === via;
  });
  const reason = (event?.data as Record<string, unknown> | undefined)?.["reason"];
  return typeof reason === "string" ? reason : null;
}

/** One line saying what's going on, and the one button that deals with it. */
function SingleAction({
  text,
  label,
  action,
  reload,
}: {
  text: string | null;
  label: string;
  action: () => Promise<unknown>;
  reload: Reload;
}) {
  const { busy, error, run } = useAction(reload);
  return (
    <div>
      {text ? <p className="action-text">{text}</p> : null}
      <div className="action-row">
        <button type="button" disabled={busy} onClick={() => void run(action)}>
          {label}
        </button>
      </div>
      <FormError error={error} />
    </div>
  );
}

/**
 * Every outcome looks the same, with none styled as the default: the UI shouldn't nudge work down the pipeline.
 * `proposals` are an improvement's at a human stage, where saving them locally is one more way on.
 */
function Outcomes({ node, proposals, reload }: { node: NodeView; proposals: ProposalView[] | null; reload: Reload }) {
  const { busy, error, run } = useAction(reload);
  const unsaveable =
    proposals === null || proposals.length === 0
      ? "There are no proposed changes to save"
      : proposals.some((p) => p.stale)
        ? "A file has changed since its proposal was drafted"
        : null;
  return (
    <div>
      {node.turn !== "human" ? <p className="action-text muted">Agent's turn. Choosing an outcome here stands in for the agent.</p> : null}
      <div className="action-row">
        {node.available_outcomes.map(({ outcome, target }) => (
          <button
            key={outcome}
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.next(node.id, outcome))}
          >
            {toTarget(humanize(outcome), target)}
          </button>
        ))}
        {proposals !== null ? (
          <button
            type="button"
            disabled={busy || unsaveable !== null}
            title={unsaveable ?? "Writes the proposed changes below to their real files"}
            onClick={() => void run(() => api.saveLocally(node.id, proposals))}
          >
            {toTarget("Save locally", "done")}
          </button>
        ) : null}
      </div>
      <FormError error={error} />
    </div>
  );
}

function Content({
  node,
  stages,
  events,
  proposals,
  reload,
}: {
  node: NodeView;
  stages: StagesView;
  events: EventView[];
  proposals?: ProposalView[] | undefined;
  reload: Reload;
}) {
  if (!node.stage_exists) {
    return (
      <div>
        <p className="action-text">Outcomes are off until this node is moved to a stage that exists.</p>
        <MoveForm node={node} stages={stages} reload={reload} />
      </div>
    );
  }
  switch (node.stage) {
    case "ask_human_question":
      return <p className="action-text">The agent asked a question. Answer it in the message box below.</p>;
    case "failed":
      return (
        <>
          <SingleAction
            text={["The agent stopped without finishing.", entryReason(events, "fail")].filter(Boolean).join(" ")}
            label={toTarget("Retry", node.return_stage)}
            action={() => api.retry(node.id)}
            reload={reload}
          />
          {node.last_run_id ? (
            <p className="action-text">
              <a className="inline-link" href={urls.runLog(node.last_run_id)} target="_blank" rel="noreferrer">
                View log
              </a>
            </p>
          ) : null}
        </>
      );
    case "externally_blocked":
      return (
        <SingleAction
          text={["Waiting on something outside AOP.", entryReason(events, "block")].filter(Boolean).join(" ")}
          label={toTarget("Unblock", node.return_stage)}
          action={() => api.unblock(node.id)}
          reload={reload}
        />
      );
    case "invalidated":
      return <SingleAction text={null} label="Restore" action={() => api.restore(node.id)} reload={reload} />;
    case "splitting":
      return (
        <p className="action-text muted">
          An agent is creating children, which stay held until it finishes the split. Forcing this node's stage ends the
          split and releases them.
        </p>
      );
    case "scheduled":
      return <ScheduleEditor node={node} reload={reload} />;
  }
  if (FINISHED_STAGES.includes(node.stage)) {
    return (
      <p className="action-text muted">{node.stage === "broken_down" ? "Finished. The work continues in the children." : "Finished."}</p>
    );
  }
  // The server saves an improvement's proposals from a human stage of its pipeline, which is any reached here.
  const saveable = node.kind === "improvement" && node.turn === "human" ? (proposals ?? []) : null;
  if (node.available_outcomes.length > 0 || saveable !== null) return <Outcomes node={node} proposals={saveable} reload={reload} />;
  return <p className="action-text muted">This stage has no outcomes. It moves on by itself, or through Force stage.</p>;
}

/**
 * What the current stage offers. Its contents are rebuilt when the stage changes, so a focused
 * outcome button can vanish. The panel then takes focus itself rather than letting it drop to the
 * top of the page, and a polite status region says which stage the node is now in.
 */
export function MovingOn(props: {
  node: NodeView;
  stages: StagesView;
  events: EventView[];
  /** An improvement's proposals, which Save locally writes. */
  proposals?: ProposalView[] | undefined;
  reload: Reload;
}) {
  const stage = props.node.stage;
  const panel = useRef<HTMLDivElement>(null);
  const holdsFocus = useRef(false);
  const shownStage = useRef(stage);
  const [notice, setNotice] = useState("");

  useLayoutEffect(() => {
    if (shownStage.current === stage) return;
    shownStage.current = stage;
    setNotice(stageChangeNotice(humanize(stage)));
    if (holdsFocus.current && focusIsLost(document.activeElement, document.body)) {
      panel.current?.focus({ preventScroll: true });
    }
  }, [stage]);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    const move = to === null ? "nowhere" : event.currentTarget.contains(to) ? "inside" : "outside";
    holdsFocus.current = stillHoldsFocus(move, event.target as HTMLElement & { disabled?: boolean });
  };

  return (
    <div
      className="panel-part moving-on"
      aria-label="Moving on"
      role="group"
      tabIndex={-1}
      ref={panel}
      onFocus={() => {
        holdsFocus.current = true;
      }}
      onBlur={onBlur}
    >
      <span className="visually-hidden" role="status">
        {notice}
      </span>
      <Fragment key={stage}>
        <Content {...props} />
      </Fragment>
    </div>
  );
}
