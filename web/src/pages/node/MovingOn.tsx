import type { EventView, NodeView, StagesView } from "../../../../src/shared/api.js";
import { api } from "../../lib/api.js";
import { humanize, toTarget } from "../../lib/format.js";
import { FINISHED_STAGES, cardKind } from "../../lib/stageStyle.js";
import { MoveForm } from "./MoveForm.js";
import { useAction } from "./useAction.js";

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
  primary,
  action,
  reload,
}: {
  text: string | null;
  label: string;
  primary: boolean;
  action: () => Promise<unknown>;
  reload: Reload;
}) {
  const { busy, error, run } = useAction(reload);
  return (
    <div>
      {text ? <p className="action-text">{text}</p> : null}
      <div className="action-row">
        <button type="button" className={primary ? "btn-primary" : undefined} disabled={busy} onClick={() => void run(action)}>
          {label}
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

function Outcomes({ node, reload }: { node: NodeView; reload: Reload }) {
  const { busy, error, run } = useAction(reload);
  // Only where a human needs to act, and then the first outcome listed in stages.yaml.
  const primaryOutcome = cardKind(node) === "human" ? node.available_outcomes[0]?.outcome : undefined;
  return (
    <div>
      {node.turn !== "human" ? <p className="action-text muted">Agent's turn. Choosing an outcome here stands in for the agent.</p> : null}
      <div className="action-row">
        {node.available_outcomes.map(({ outcome, target }) => (
          <button
            key={outcome}
            type="button"
            className={outcome === primaryOutcome ? "btn-primary" : undefined}
            disabled={busy}
            onClick={() => void run(() => api.next(node.id, outcome))}
          >
            {toTarget(humanize(outcome), target)}
          </button>
        ))}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

function Content({
  node,
  stages,
  events,
  reload,
}: {
  node: NodeView;
  stages: StagesView;
  events: EventView[];
  reload: Reload;
}) {
  if (!node.stage_exists) {
    return (
      <div>
        <p className="action-text">Outcomes are off until this node is moved to a stage that exists.</p>
        <MoveForm node={node} stages={stages} primary reload={reload} />
      </div>
    );
  }
  switch (node.stage) {
    case "ask_human_question":
      return <p className="action-text">The agent asked a question. Answer it in the message box below.</p>;
    case "failed":
      return (
        <SingleAction
          text={["The agent stopped without finishing.", entryReason(events, "fail")].filter(Boolean).join(" ")}
          label={toTarget("Retry", node.return_stage)}
          primary
          action={() => api.retry(node.id)}
          reload={reload}
        />
      );
    case "externally_blocked":
      return (
        <SingleAction
          text={["Waiting on something outside AOP.", entryReason(events, "block")].filter(Boolean).join(" ")}
          label={toTarget("Unblock", node.return_stage)}
          primary
          action={() => api.unblock(node.id)}
          reload={reload}
        />
      );
    case "invalidated":
      // Nobody needs to act on an invalidated node, so restoring it isn't a primary action.
      return <SingleAction text={null} label="Restore" primary={false} action={() => api.restore(node.id)} reload={reload} />;
    case "splitting":
      return (
        <p className="action-text muted">
          An agent is creating children, which stay held until it finishes the split. Moving this node by hand ends the
          split and releases them.
        </p>
      );
    case "scheduled":
      return (
        <p className="action-text muted">
          Stays here and creates a child each time it fires. Schedule: <code>{node.cron}</code>
        </p>
      );
  }
  if (FINISHED_STAGES.includes(node.stage)) {
    return (
      <p className="action-text muted">{node.stage === "broken_down" ? "Finished. The work continues in the children." : "Finished."}</p>
    );
  }
  if (node.available_outcomes.length > 0) return <Outcomes node={node} reload={reload} />;
  return <p className="action-text muted">This stage has no outcomes. It moves on by itself, or by hand.</p>;
}

/** What the current stage offers. */
export function MovingOn(props: { node: NodeView; stages: StagesView; events: EventView[]; reload: Reload }) {
  return (
    <div className="panel-part moving-on" aria-label="Moving on" role="group" key={props.node.stage}>
      <Content {...props} />
    </div>
  );
}
