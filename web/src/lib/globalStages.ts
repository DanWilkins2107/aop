import type { BuiltInStage } from "../../../src/shared/stages/types.js";

/** The built-in stages reachable from anywhere, so they live outside every type's pipeline. */
export const GLOBAL_STAGES: readonly string[] = [
  "invalidated",
  "externally_blocked",
  "ask_human_question",
  "failed",
] as const satisfies readonly BuiltInStage[];
