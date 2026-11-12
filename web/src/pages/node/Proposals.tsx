import { useState } from "react";
import type { NodeView, ProposalView } from "../../../../src/shared/api/types.js";
import { FINISHED_STAGES } from "../../../../src/shared/domain/builtInStages.js";
import { api } from "../../lib/api.js";
import { diffLines, diffStats, withContext } from "../../lib/diff.js";
import { useAction } from "../../lib/useAction.js";

/** Improvements that can't change any more. */
const CLOSED_STAGES: readonly string[] = [...FINISHED_STAGES, "invalidated"];

function Diff({ proposal }: { proposal: ProposalView }) {
  const lines = diffLines(proposal.current, proposal.proposed);
  const { added, removed } = diffStats(lines);
  if (added === 0 && removed === 0) return <p className="muted section-text">Same as the current file.</p>;
  return (
    <div className="diff" role="table" aria-label={`Changes to ${proposal.display_path}`}>
      {withContext(lines).map((chunk, index) =>
        chunk.kind === "skipped" ? (
          <div key={`s${index}`} className="diff-skip" role="row">
            {chunk.count} unchanged line{chunk.count === 1 ? "" : "s"}
          </div>
        ) : (
          chunk.lines.map((line) => (
            <div key={`${line.oldLine ?? "-"}:${line.newLine ?? "-"}`} className={`diff-line diff-${line.kind}`} role="row">
              <span className="diff-mark" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
              </span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))
        ),
      )}
    </div>
  );
}

/** A file that changed after its proposal was drafted: saving it would undo that change, so it's refused. */
function StaleNote({ node, editable }: { node: NodeView; editable: boolean }) {
  const canRedraft = node.available_outcomes.some((o) => o.outcome === "redraft");
  const ways = [canRedraft ? "Redraft to draft it again" : null, editable ? "Edit and save to keep it as it is" : null].filter(Boolean);
  return (
    <p className="section-text proposal-stale">
      This file has changed since the proposal was drafted, so nothing can be saved locally until it's updated. The diff is against
      the file as it is now.{ways.length > 0 ? ` ${ways.join(", or ")}.` : ""}
    </p>
  );
}

function Proposal({ node, proposal, editable, reload }: { node: NodeView; proposal: ProposalView; editable: boolean; reload: () => Promise<void> }) {
  // Null while reading, so live updates show through unless there's a draft to protect.
  const [draft, setDraft] = useState<string | null>(null);
  const { busy, error, run } = useAction(reload);
  const { added, removed } = diffStats(diffLines(proposal.current, proposal.proposed));

  async function save() {
    if (draft === null) return;
    if (await run(() => api.saveProposal(node.id, proposal.path, draft))) setDraft(null);
  }

  return (
    <section className="panel-part proposal" aria-label={proposal.display_path}>
      <div className="section-head">
        <h3 className="proposal-path mono" title={proposal.path}>
          {proposal.display_path}
        </h3>
        <span className="proposal-stats muted">
          {proposal.stale ? <span className="proposal-stale-mark">Changed since drafted</span> : null}
          {proposal.current === null ? "New file" : `+${added} −${removed}`}
          {editable && draft === null ? (
            <button type="button" className="btn-quiet proposal-edit" onClick={() => setDraft(proposal.proposed)}>
              Edit
            </button>
          ) : null}
        </span>
      </div>
      {proposal.stale && draft === null ? <StaleNote node={node} editable={editable} /> : null}
      {draft === null ? (
        <Diff proposal={proposal} />
      ) : (
        <>
          <textarea
            autoFocus
            className="mono proposal-editor"
            rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Proposed ${proposal.display_path}`}
          />
          <div className="action-row">
            <button type="button" disabled={busy || draft === proposal.proposed} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error ? <div className="form-error">{error}</div> : null}
    </section>
  );
}

/** What the improvement would change, as a diff against the real files, which stay untouched until a human saves it. */
export function Proposals({ node, proposals, reload }: { node: NodeView; proposals: ProposalView[]; reload: () => Promise<void> }) {
  const editable = node.turn === "human" && !CLOSED_STAGES.includes(node.stage) && node.stage_exists;
  return (
    <section className="panel" aria-label="Proposed changes">
      <h2>Proposed changes</h2>
      {proposals.length === 0 ? (
        <p className="muted section-text">No changes proposed yet.</p>
      ) : (
        <p className="muted section-text">Nothing is written to these files until the change is saved locally or raised as a PR.</p>
      )}
      {proposals.map((proposal) => (
        <Proposal key={proposal.id} node={node} proposal={proposal} editable={editable} reload={reload} />
      ))}
    </section>
  );
}
