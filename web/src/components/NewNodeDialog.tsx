import { useState } from "react";
import type { NodeView, StagesView } from "../../../src/shared/api/types.js";
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
  const { busy, error, run } = useAction();

  // A node enters at its type's own start. Types starting at scheduled aren't offered for now.
  const start = findType(stages, type)?.start;
  const types = stages.types.filter((option) => option.start !== "scheduled");

  async function create() {
    await run(async () => onCreated(await api.createNode(projectId, { type, title: title.trim(), body })));
  }

  return (
    <Dialog
      title="New node"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void create()}
      error={error}
      submitLabel="Create node"
      canSubmit={title.trim() !== ""}
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
          {types.map((option) => (
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
    </Dialog>
  );
}
