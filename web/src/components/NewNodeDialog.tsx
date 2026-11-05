import { useState } from "react";
import type { NodeView, StagesView } from "../../../src/shared/api.js";
import { api } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { findType } from "../lib/stageStyle.js";
import { useAction } from "../lib/useAction.js";
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
  const [type, setType] = useState(stages.start);
  const [cron, setCron] = useState("");
  const { busy, error, run } = useAction();

  // A node enters at its type's own start.
  const start = findType(stages, type)?.start;
  const scheduled = start === "scheduled";

  async function create() {
    const input = { type, title: title.trim(), body };
    await run(async () => onCreated(await api.createNode(projectId, scheduled ? { ...input, cron: cron.trim() } : input)));
  }

  return (
    <Dialog
      title="New node"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void create()}
      error={error}
      submitLabel="Create node"
      canSubmit={title.trim() !== "" && (!scheduled || cron.trim() !== "")}
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
        Starts in
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Starts in">
          {stages.types.map((option) => (
            <option key={option.name} value={option.name}>
              {humanize(option.name)}
              {option.name === stages.start ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>
      {start ? (
        <p className="field-hint">
          Type {humanize(type)}, starting at {humanize(start)}.
        </p>
      ) : null}
      {scheduled ? (
        <label>
          Cron schedule
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 3 * * *" className="mono" />
        </label>
      ) : null}
    </Dialog>
  );
}
