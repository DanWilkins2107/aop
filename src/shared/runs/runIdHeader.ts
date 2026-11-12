/**
 * The header carrying the run ID a write comes from: every MCP write tool sends its `run_id` in it.
 * That's an agent run's ID, or a steered session's `steer_id`. The server refuses a write from a run
 * that has ended or a session whose claim was released, and a stage change from any run but the one
 * on that node, or a session on another node.
 */
export const RUN_ID_HEADER = "x-aop-run-id";
