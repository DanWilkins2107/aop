import { useState } from "react";
import type { NodeView, StagesView } from "../../../../src/shared/api.js";
import { ClaimMark } from "../../components/ClaimMark.js";
import { Dialog } from "../../components/Dialog.js";
import { api } from "../../lib/api.js";
import { humanize } from "../../lib/format.js";
import { FINISHED_STAGES } from "../../../../src/shared/builtInStages.js";
import { useAction } from "../../lib/useAction.js";
import { MoveForm } from "./MoveForm.js";
import { Part } from "./Part.js";

type Reload = () => Promise<void>;

/** Asks for a reason, then runs an action with it. */
function ReasonButton({
  label,
  title,
  hint,
  placeholder,
  submitLabel,
  action,
  reload,
}: {
  label: string;
  title: string;
  hint: string;
  placeholder: string;
  submitLabel: string;
  action: (reason: string) => Promise<unknown>;
  reload: Reload;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction(reload);
  return (
    <>
      <button type="button" className="btn-small" onClick={() => setOpen(true)}>
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
          submitClass=""
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

/** A human can release their own claim here. An agent's ends with its run, which can be stopped. */
function ClaimControls({ node, reload }: { node: NodeView; reload: Reload }) {
  const { busy, error, run } = useAction(reload);
  return (
    <>
      <div className="action-row">
        <ClaimMark node={node} />
        {node.claimed_by === "human" ? (
          <button type="button" disabled={busy} onClick={() => void run(() => api.release(node.id))}>
            Release claim
          </button>
        ) : null}
        {node.run_id ? (
          <button type="button" disabled={busy} onClick={() => void run(() => api.stopRun(node.run_id as string))}>
            Stop run
          </button>
        ) : null}
        {node.claimed_by === null && !node.run_id ? (
          <>
            <span className="muted">Not claimed</span>
            <button type="button" disabled={busy} onClick={() => void run(() => api.claim(node.id))}>
              Claim
            </button>
          </>
        ) : null}
      </div>
      {node.run_id ? (
        <p className="field-hint">The node stays on this stage, claimed by you. Release the claim to start the stage again.</p>
      ) : null}
      {error ? <div className="form-error">{error}</div> : null}
    </>
  );
}

/** The Header card's controls, collapsed beside the pipeline: force stage, invalidate or block, and claim. */
export function NodeControls({ node, stages, reload }: { node: NodeView; stages: StagesView; reload: Reload }) {
  const invalidated = node.stage === "invalidated";
  const canBlock = !FINISHED_STAGES.includes(node.stage) && !invalidated && node.stage !== "externally_blocked";
  return (
    <>
      {node.stage_exists ? (
        <Part title="Force stage">
          <MoveForm node={node} stages={stages} reload={reload} />
        </Part>
      ) : null}
      {!invalidated ? (
        <Part title="Invalidate or block">
          <div className="action-row">
            <ReasonButton
              label="Invalidate"
              title="Invalidate this node"
              hint="Its descendants will read as invalidated by parent. It can be restored later."
              placeholder="Why is this no longer valid?"
              submitLabel="Invalidate"
              action={(reason) => api.invalidate(node.id, reason)}
              reload={reload}
            />
            {canBlock ? (
              <ReasonButton
                label="Mark externally blocked"
                title="Mark externally blocked"
                hint={`No agent starts here until you unblock it, and anything it blocks stays blocked. Unblocking returns it to ${humanize(node.stage)}.`}
                placeholder="What is it waiting on?"
                submitLabel="Mark blocked"
                action={(reason) => api.block(node.id, reason)}
                reload={reload}
              />
            ) : null}
          </div>
        </Part>
      ) : null}
      <Part title="Claim" status={node.claimed_by ?? "none"} defaultOpen>
        <ClaimControls node={node} reload={reload} />
      </Part>
    </>
  );
}
