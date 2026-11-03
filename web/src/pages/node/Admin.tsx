import { useState } from "react";
import type { EdgeRow, EventView, NodeView, StagesView } from "../../../../src/shared/api.js";
import { ClaimMark } from "../../components/ClaimMark.js";
import { Dialog } from "../../components/Dialog.js";
import { api } from "../../lib/api.js";
import { humanize } from "../../lib/format.js";
import { FINISHED_STAGES } from "../../lib/stageStyle.js";
import { Edges } from "./Edges.js";
import { History } from "./History.js";
import { MoveForm } from "./MoveForm.js";
import { useAction } from "./useAction.js";

type Reload = () => Promise<void>;

/** Asks for a reason, then runs an action with it. */
function ReasonButton({
  label,
  title,
  hint,
  placeholder,
  submitLabel,
  submitClass,
  action,
  reload,
}: {
  label: string;
  title: string;
  hint: string;
  placeholder: string;
  submitLabel: string;
  submitClass?: string;
  action: (reason: string) => Promise<unknown>;
  reload: Reload;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction(reload);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <Dialog
          title={title}
          busy={busy}
          onClose={() => setOpen(false)}
          onSubmit={() => void run(() => action(reason.trim())).then((ok) => ok && setOpen(false))}
          error={error}
          submitLabel={submitLabel}
          {...(submitClass ? { submitClass } : {})}
          canSubmit={reason.trim() !== ""}
        >
          <p className="field-hint">{hint}</p>
          <label>
            Reason
            <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} />
          </label>
        </Dialog>
      ) : null}
    </>
  );
}

/** Only a human's claim can be released here: an agent's ends with its run. */
function ClaimControls({ node, reload }: { node: NodeView; reload: Reload }) {
  const { busy, error, run } = useAction(reload);
  return (
    <>
      <div className="action-row">
        <ClaimMark node={node} />
        {node.claimed_by === "human" ? (
          <>
            <button type="button" disabled={busy} onClick={() => void run(() => api.release(node.id))}>
              Release claim
            </button>
          </>
        ) : null}
        {node.claimed_by === null ? (
          <>
            <span className="muted">Not claimed</span>
            <button type="button" disabled={busy} onClick={() => void run(() => api.claim(node.id))}>
              Claim
            </button>
          </>
        ) : null}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </>
  );
}

export function Admin({
  node,
  edges,
  nodes,
  events,
  stages,
  titleOf,
  reload,
}: {
  node: NodeView;
  edges: EdgeRow[];
  nodes: NodeView[];
  events: EventView[];
  stages: StagesView;
  titleOf: (id: string) => string;
  reload: Reload;
}) {
  const invalidated = node.stage === "invalidated";
  const canBlock = !FINISHED_STAGES.includes(node.stage) && !invalidated && node.stage !== "externally_blocked";

  return (
    <div className="admin">
      <div className="admin-row">
        <h3>Edges</h3>
        <Edges node={node} edges={edges} nodes={nodes} reload={reload} />
      </div>
      <div className="admin-row">
        <h3>History</h3>
        <History events={events} titleOf={titleOf} />
      </div>
      <div className="admin-row">
        <h3>Claim</h3>
        <ClaimControls node={node} reload={reload} />
      </div>
      {!invalidated ? (
        <div className="admin-row">
          <h3>Invalidate or block</h3>
          <div className="action-row">
            <ReasonButton
              label="Invalidate…"
              title="Invalidate this node"
              hint="Its descendants will read as invalidated by parent. It can be restored later."
              placeholder="Why is this no longer valid?"
              submitLabel="Invalidate"
              submitClass="btn-danger"
              action={(reason) => api.invalidate(node.id, reason)}
              reload={reload}
            />
            {canBlock ? (
              <ReasonButton
                label="Mark externally blocked…"
                title="Mark externally blocked"
                hint={`No agent starts here until you unblock it, and anything it blocks stays blocked. Unblocking returns it to ${humanize(node.stage)}.`}
                placeholder="What is it waiting on?"
                submitLabel="Mark blocked"
                action={(reason) => api.block(node.id, reason)}
                reload={reload}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {node.stage_exists ? (
        <div className="admin-row">
          <h3>Move by hand</h3>
          <MoveForm node={node} stages={stages} reload={reload} />
        </div>
      ) : null}
    </div>
  );
}
