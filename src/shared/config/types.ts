/** The machine's `config.yaml`, with defaults filled in. `settings` is null while it's invalid. */
export interface ConfigView {
  config_path: string;
  problems: string[];
  settings: {
    agent_session_command: string;
    out_of_sandbox_command: string | null;
    open_from: string;
    open_from_path: string;
    agent_timeout_minutes: number;
    stages: string;
    stages_path: string;
    /** Projects with a process of their own, from `project_stages`. Every other project follows `stages`. */
    project_stages: ProjectStagesSetting[];
    /** Null when improvements are off. */
    improvement_stages: string | null;
    improvement_stages_path: string | null;
    improvements_path: string;
    /** `improvements_path`, resolved. */
    improvements_dir: string;
    /** The git repo holding it, which Raise PR needs. */
    improvements_repo: string | null;
  } | null;
}

interface ProjectStagesSetting {
  project_id: string;
  /** As written in `config.yaml`. */
  stages: string;
  stages_path: string;
}

/** `config.yaml`, a process file it names, or one of their agent stages' prompts. */
export type ConfigFileKind = "config" | "stages" | "prompt";

/** A file the settings and process pages can edit. */
export interface ConfigFileView {
  path: string;
  kind: ConfigFileKind;
  /** Null when there's no file yet. */
  content: string | null;
}

export interface SaveConfigFileRequest {
  path: string;
  content: string;
  /** What the file held when it was shown, or null if there was none. The save is refused if it has changed since. */
  base: string | null;
}
