import { useState } from "react";
import { Link } from "react-router-dom";
import type { ProjectRow } from "../../../src/shared/projects/types.js";
import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";
import { useAction } from "../lib/useAction.js";
import { Dialog } from "./Dialog.js";

interface NewProjectProps {
  onClose: () => void;
  /** Called after the change has saved. */
  onDone: () => void;
}

interface ProjectProps extends NewProjectProps {
  project: ProjectRow;
}

/** Runs one request for a dialog, keeping it open with the reason if the server refuses. */
function useSave(onDone: () => void) {
  const { busy, error, run } = useAction();
  const save = (request: () => Promise<unknown>) =>
    run(async () => {
      await request();
      onDone();
    });
  return { busy, error, save };
}

/** Says where agents start without a repo path, once the config has said. */
export function RepoPathHint({ openFrom }: { openFrom: string | null }) {
  if (!openFrom) return null;
  return (
    <p className="field-hint">
      With no path, they start in <code>{openFrom}</code> - this is set in your <Link to="/settings">global config</Link>.
    </p>
  );
}

export function AddProjectDialog({ onClose, onDone }: NewProjectProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const { busy, error, save } = useSave(onDone);
  const { data: config } = useLiveData(() => api.config(), "config");
  return (
    <Dialog
      title="Add project"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void save(() => api.addProject(name, path.trim() || null))}
      error={error}
      submitLabel="Add project"
      canSubmit={name.trim() !== ""}
    >
      <label>
        Name
        <input autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span>
          Repo path <span className="muted">(optional)</span>
        </span>
        <input className="mono" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
      </label>
      <RepoPathHint openFrom={config?.settings?.open_from_path ?? null} />
    </Dialog>
  );
}

export function DeleteProjectDialog({ project, onClose, onDone }: ProjectProps) {
  const [typed, setTyped] = useState("");
  const { busy, error, save } = useSave(onDone);
  return (
    <Dialog
      title="Delete project"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void save(() => api.deleteProject(project.id))}
      error={error}
      submitLabel="Delete permanently"
      submitClass="btn-danger"
      canSubmit={typed.trim() === project.name.trim()}
    >
      <p className="dialog-text">
        This permanently deletes <strong>{project.name}</strong> from AOP, with all its nodes, edges, links, messages,
        events and runs. It can't be undone.
      </p>
      <label>
        Type the project's name to confirm
        <input autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </Dialog>
  );
}
