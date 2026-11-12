import type { Actor, Turn } from "../nodes/types.js";

export type BuiltInStage =
  | "done"
  | "broken_down"
  | "invalidated"
  | "scheduled"
  | "ask_human_question"
  | "failed"
  | "externally_blocked"
  | "splitting";

/** How a node's stage changed: the action that moved it. Also a run's `left_via`. */
export type StageChangeVia =
  | "next"
  | "move"
  | "ask"
  | "answer"
  | "fail"
  | "retry"
  | "invalidate"
  | "restore"
  | "block"
  | "unblock"
  | "split_start"
  | "split_finish"
  /** A human saved an improvement's proposals to their real files, which finished it. */
  | "save_locally";

/** A process file (the shared `stages.yaml` or a project's own), in file order. Built-in stages aren't listed unless a type uses one. */
export interface StagesView {
  /** The type new nodes enter. */
  start: string;
  stages: { name: string; turn: Turn; color: string | null }[];
  types: TypeView[];
}

export interface TypeView {
  name: string;
  start: string;
  stages: { name: string; next: { outcome: string; target: string }[] }[];
}

/** The process page: `stages.yaml` as far as it could be read, with every problem in the config. */
export interface ProcessView {
  /** Absolute path, or null when `config.yaml` doesn't say where the file is. */
  stages_path: string | null;
  problems: string[];
  process: StagesView | null;
  /** Projects with a process of their own, when the config is valid. */
  project_processes: { project_id: string; stages_path: string; process: StagesView }[];
  /** The improvement pipeline, when the config is valid and improvements are on. */
  improvement_stages_path: string | null;
  improvement_process: StagesView | null;
  /** Things in the improvement pipeline that still load but no longer do what they did. */
  improvement_notes: string[];
}

export interface NextRequest {
  outcome: string;
  actor?: Actor;
}

export interface MoveRequest {
  stage: string;
  type?: string;
}

export interface AskRequest {
  question: string;
}

export interface AnswerRequest {
  answer: string;
}

export interface FailRequest {
  actor?: Actor;
  reason?: string;
}

export interface InvalidateRequest {
  reason: string;
  actor?: Actor;
}

export interface BlockRequest {
  reason: string;
  actor?: Actor;
}
