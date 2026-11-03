import { useState } from "react";
import type { NodeView, StagesView } from "../../../src/shared/api.js";
import { api, failureText } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { findType } from "../lib/stageStyle.js";
import { Dialog } from "./Dialog.js";

export function NewNodeDialog({
  projectId,
  stages,
  onClose,
  onCreated,
}: {
  projectId: string;
  stages: StagesView;
  onClose: () => void;
  onCreated: (node: NodeView) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // The first type in the file, until `stages.yaml` gets a top-level `start` to say otherwise.
  const [typeName, setTypeName] = useState(stages.types[0]?.name ?? "");
  const [cron, setCron] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = findType(stages, typeName)?.start;
  const scheduled = start === "scheduled";

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const input = { type: typeName, title: title.trim(), body };
      onCreated(await api.createNode(projectId, scheduled ? { ...input, cron: cron.trim() } : input));
    } catch (failure) {
      setError(failureText(failure));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="New node"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void create()}
      error={error}
      submitLabel="Create node"
      canSubmit={title.trim() !== "" && typeName !== "" && (!scheduled || cron.trim() !== "")}
    >
      <label>
        Title
        <input autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
      </label>
      <label>
        Description
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Optional" />
      </label>
      <label>
        <span>
          Type <span className="muted">(optional)</span>
        </span>
        <select value={typeName} onChange={(e) => setTypeName(e.target.value)} aria-label="Type">
          {stages.types.map((type) => (
            <option key={type.name} value={type.name}>
              {humanize(type.name)}
            </option>
          ))}
        </select>
      </label>
      {start ? <p className="field-hint">Starts at {humanize(start)}.</p> : null}
      {scheduled ? (
        <label>
          Cron schedule
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 3 * * *" className="mono" />
        </label>
      ) : null}
    </Dialog>
  );
}
