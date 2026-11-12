import type { Actor, NodeView } from "../nodes/types.js";

/** Where an improvement came from. The IDs are cleared if the source project is deleted; the text stays. */
export interface ImprovementSource {
  node_id: string | null;
  message_id: string | null;
  project_id: string | null;
  /** The source message's text, as it was when the improvement was captured. */
  excerpt: string;
  node_title: string;
  /** Null once the project has gone. */
  project_name: string | null;
}

export interface ImprovementView {
  node: NodeView;
  source: ImprovementSource | null;
  proposal_count: number;
}

/** The Improvements tab. `note` says why improvements are off, when they are. */
export interface ImprovementsList {
  enabled: boolean;
  note: string | null;
  improvements: ImprovementView[];
}

/** An improvement's page, with what its agents may change. */
export interface ImprovementDetail extends ImprovementView {
  improvements_dir: string;
  /** False hides the outcomes that lead to `raise_pr`. */
  raise_pr_available: boolean;
}

/** One proposed file, with the real file's current contents to diff against. */
export interface ProposalView {
  id: string;
  /** Absolute. */
  path: string;
  /** Relative to the improvements folder when it's inside it, otherwise the absolute path. */
  display_path: string;
  proposed: string;
  /** Null when the file doesn't exist yet. */
  current: string | null;
  /**
   * The real file has changed since this was last saved, so saving locally is refused until it's
   * saved again. False when that's unknown, for proposals saved before AOP recorded it.
   */
  stale: boolean;
  /** Names this path and these proposed contents. A save sends back the ones it was shown. */
  revision: string;
  updated_at: string;
  updated_by: "human" | "agent";
}

export interface ApplyResult {
  /** Absolute paths written. */
  written: string[];
}

export interface ImprovementRequest {
  body: string;
  source_message_id?: string;
  actor?: Actor;
}

export interface ProposalRequest {
  path: string;
  content: string;
  actor?: Actor;
}

export interface WithdrawRequest {
  path: string;
  actor?: Actor;
}

/** Saving locally. `reviewed` is every proposal the human's page showed, by the `revision` each had. */
export interface ApplyRequest {
  reviewed: { path: string; revision: string }[];
  actor?: Actor;
}
