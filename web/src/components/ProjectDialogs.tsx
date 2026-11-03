import { useState } from "react";
import type { ProjectRow } from "../../../src/shared/api.js";
import { api, failureText } from "../lib/api.js";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (request: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await request();
      onDone();
    } catch (failure) {
      setError(failureText(failure));
      setBusy(false);
    }
  };
  return { busy, error, save };
}

export function AddProjectDialog({ onClose, onDone }: NewProjectProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const { busy, error, save } = useSave(onDone);
  return (
    <Dialog
      title="Add project"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void save(() => api.addProject(name, path))}
      error={error}
      submitLabel="Add project"
      canSubmit={name.trim() !== "" && path.trim() !== ""}
    >
      <label>
        Name
        <input autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Repo path
        <input className="mono" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
      </label>
      <p className="field-hint">The full path of an existing folder. AOP doesn't write anything to it.</p>
    </Dialog>
  );
}

export function RenameProjectDialog({ project, onClose, onDone }: ProjectProps) {
  const [name, setName] = useState(project.name);
  const { busy, error, save } = useSave(onDone);
  return (
    <Dialog
      title="Rename project"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void save(() => api.updateProject(project.id, { name }))}
      error={error}
      submitLabel="Rename"
      canSubmit={name.trim() !== "" && name.trim() !== project.name}
    >
      <label>
        Name
        <input autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
    </Dialog>
  );
}

export function ChangeProjectPathDialog({ project, onClose, onDone }: ProjectProps) {
  const [path, setPath] = useState(project.repo_path);
  const { busy, error, save } = useSave(onDone);
  return (
    <Dialog
      title="Change repo path"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void save(() => api.updateProject(project.id, { repo_path: path }))}
      error={error}
      submitLabel="Change path"
      canSubmit={path.trim() !== "" && path.trim() !== project.repo_path}
    >
      <label>
        Repo path
        <input autoFocus className="mono" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
      </label>
      <p className="field-hint">Use this when the repo has moved. AOP doesn't move any files.</p>
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
      <p className="dialog-text">
        The repo folder isn't touched: <code>{project.repo_path}</code>
      </p>
      <label>
        Type the project's name to confirm
        <input autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </Dialog>
  );
}
