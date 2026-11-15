import { useState } from "react";
import type { ConfigFileView } from "../../../src/shared/config/types.js";
import { ApiFailure, api, failureText } from "../lib/api.js";
import { useAction } from "../lib/useAction.js";
import { FormError, useFormError } from "./FormError.js";

/** A refused save's message, then each problem the server found in the file. */
function saveFailureText(failure: unknown): string {
  const problems = failure instanceof ApiFailure && Array.isArray(failure.details) ? failure.details.filter((p) => typeof p === "string") : [];
  return [failureText(failure), ...problems.map((problem) => `• ${problem}`)].join("\n");
}

/**
 * One of AOP's own files, such as `config.yaml`, with an Edit button. The server checks the new
 * contents before saving, and refuses if the file changed after editing began.
 */
export function FileEditor({ file, title, reload }: { file: ConfigFileView; title: string; reload: () => Promise<void> }) {
  // What the file held when editing began, which the save is checked against. Null while reading.
  const [draft, setDraft] = useState<{ text: string; base: string | null } | null>(null);
  const { busy, error, run } = useAction(reload, saveFailureText);
  const { errorId, describedBy } = useFormError(error);

  async function save() {
    if (draft === null) return;
    if (await run(() => api.saveConfigFile(file.path, draft.text, draft.base))) setDraft(null);
  }

  return (
    <div className="file-editor" aria-label={title} role="group">
      <div className="section-head">
        <span>
          {title} <code title={file.path}>{file.path}</code>
          {file.content === null ? <span className="muted"> (no file yet)</span> : null}
        </span>
        {draft === null ? (
          <button type="button" className="btn-quiet" onClick={() => setDraft({ text: file.content ?? "", base: file.content })}>
            Edit
          </button>
        ) : null}
      </div>
      {draft === null ? null : (
        <>
          <textarea
            autoFocus
            className="mono file-editor-text"
            rows={Math.min(30, Math.max(6, draft.text.split("\n").length + 1))}
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            aria-label={file.path}
            aria-describedby={describedBy}
            spellCheck={false}
          />
          <div className="action-row">
            <button type="button" disabled={busy || draft.text === draft.base} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      <FormError error={error} id={errorId} />
    </div>
  );
}
