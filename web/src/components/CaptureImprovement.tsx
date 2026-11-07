import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ImprovementView } from "../../../src/shared/api.js";
import { api } from "../lib/api.js";
import { useAction } from "../lib/useAction.js";

/**
 * A text box for a new improvement, then an even choice between going to it and closing, which
 * leaves you where you were. An agent starts on it as soon as it's confirmed.
 */
export function CaptureImprovement({
  sourceMessageId,
  onClose,
  onCreated,
}: {
  sourceMessageId?: string;
  onClose: () => void;
  onCreated?: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [created, setCreated] = useState<ImprovementView | null>(null);
  const { busy, error, run } = useAction(onCreated);
  const navigate = useNavigate();

  if (created) {
    return (
      <div className="capture" role="group" aria-label="Improvement created">
        <p className="action-text">Improvement created. An agent is drafting it.</p>
        <div className="action-row">
          <button type="button" onClick={() => void navigate(`/n/${created.node.id}`)}>
            Go to improvement
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const confirm = async () => {
    if (text.trim() === "" || busy) return;
    await run(async () => setCreated(await api.createImprovement(text, sourceMessageId)));
  };

  return (
    <form
      className="capture"
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should agents do differently?"
        aria-label="Improvement"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      />
      <div className="action-row">
        <button type="submit" disabled={busy || text.trim() === ""}>
          Confirm
        </button>
        <button type="button" className="btn-quiet" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </form>
  );
}
