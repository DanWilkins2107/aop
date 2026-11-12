import type { BuiltInStage } from "./types.js";

// What each built-in does is in `src/server/stageMachine.ts`, and `scheduled` in `src/server/scheduler.ts`.
const BUILT_IN_STAGES: Record<BuiltInStage, true> = {
  done: true,
  broken_down: true,
  invalidated: true,
  scheduled: true,
  ask_human_question: true,
  failed: true,
  externally_blocked: true,
  splitting: true,
};

export function isBuiltIn(name: string): name is BuiltInStage {
  return Object.hasOwn(BUILT_IN_STAGES, name);
}
