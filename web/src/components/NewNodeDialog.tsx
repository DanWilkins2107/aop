import { useState } from "react";
import type { NodeView, StagesView } from "../../../src/shared/api.js";
import { api, failureText } from "../lib/api.js";
import { humanize, stageOptionGroups } from "../lib/format.js";
import { findType } from "../lib/stageStyle.js";
import { Dialog } from "./Dialog.js";

/** A value of the "Starts in" dropdown. A type enters at its own start. */
interface StartChoice {
  type: string;
  stage?: string;
}

const typeChoice = (type: string) => JSON.stringify({ type } satisfies StartChoice);

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
  const [choice, setChoice] = useState(typeChoice(stages.start));
  const [cron, setCron] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = JSON.parse(choice) as StartChoice;
  const start = chosen.stage ?? findType(stages, chosen.type)?.start;
  const scheduled = start === "scheduled";

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const input = { ...chosen, title: title.trim(), body };
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
        <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Starts in">
          <optgroup label="Type">
            {stages.types.map((type) => (
              <option key={type.name} value={typeChoice(type.name)}>
                {humanize(type.name)}
                {type.name === stages.start ? " (default)" : ""}
              </option>
            ))}
          </optgroup>
          {stageOptionGroups(stages).map(({ group, options }) => (
            <optgroup key={group} label={`Stage in ${group}`}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {start ? (
        <p className="field-hint">
          Type {humanize(chosen.type)}, starting at {humanize(start)}.
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
