import type { BuiltInStage } from "./types.js";

/**
 * A blocker at one of these holds nothing, so its `blocks` edges stop counting. A `broken_down` one
 * isn't here: it only has blocks left if a human moved it there.
 */
export const NON_BLOCKING_STAGES: readonly string[] = ["done", "invalidated"] as const satisfies readonly BuiltInStage[];
