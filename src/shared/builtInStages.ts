/**
 * The built-in stages and the facts about them that both the server and the browser need. No imports,
 * so the browser can load it too. What each built-in does is in `src/server/nodes.ts`, and `scheduled`
 * in `src/server/scheduler.ts`. `specs/built-in-stages.md` is the source, and a test checks these agree.
 */

export const BUILT_IN_STAGES = [
  "done",
  "broken_down",
  "invalidated",
  "scheduled",
  "ask_human_question",
  "failed",
  "externally_blocked",
  "splitting",
] as const;

export type BuiltInStage = (typeof BUILT_IN_STAGES)[number];

export function isBuiltIn(name: string): name is BuiltInStage {
  return (BUILT_IN_STAGES as readonly string[]).includes(name);
}

const finished = ["done", "broken_down"] as const satisfies readonly BuiltInStage[];
export type FinishedStage = (typeof finished)[number];

/** The built-ins that finish a node. They're also the only built-ins `next` can target. */
export const FINISHED_STAGES: readonly string[] = finished;

/** Reachable from anywhere, so they live outside every type's pipeline. */
export const GLOBAL_STAGES: readonly string[] = [
  "invalidated",
  "externally_blocked",
  "ask_human_question",
  "failed",
] as const satisfies readonly BuiltInStage[];

/** The built-ins where it's the human's move. */
export const HUMAN_TURN_STAGES: readonly string[] = [
  "ask_human_question",
  "failed",
  "externally_blocked",
] as const satisfies readonly BuiltInStage[];

/** The built-ins where it's the agent's move. */
export const AGENT_TURN_STAGES: readonly string[] = ["splitting"] as const satisfies readonly BuiltInStage[];

/** Built-ins entered only through an action of their own, which collects their state. */
export type OwnActionStage = Exclude<BuiltInStage, FinishedStage | "scheduled">;
