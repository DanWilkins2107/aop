import type { BuiltInStage } from "./types.js";

/** The built-ins that finish a node. They're also the only built-ins `next` can target. */
export const FINISHED_STAGES: readonly string[] = ["done", "broken_down"] as const satisfies readonly BuiltInStage[];
