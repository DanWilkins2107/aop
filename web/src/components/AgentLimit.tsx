import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";
import { useAction } from "../lib/useAction.js";

/**
 * The top bar's count of running agents, and the most that may run at once. Lowering the limit
 * stops nothing: nodes past it wait in the queue until enough agents have finished.
 */
export function AgentLimit() {
  const { data, reload } = useLiveData(() => api.agentLimit(), "agent-limit");
  const { busy, error, run } = useAction(reload);
  if (!data) return null;
  const { limit, running } = data;
  const set = (next: number | null) => void run(() => api.setAgentLimit(next));
  // From no limit, the first step down caps it at what's running now.
  const lower = limit === null ? Math.max(running, 1) : limit - 1;
  return (
    <span className="agent-limit" title={error ?? "The most agents that run at once. Lowering it stops none."}>
      <span className="agent-limit-label">
        Agents {running}/{limit ?? "∞"}
      </span>
      <button type="button" aria-label="Allow one agent fewer" disabled={busy || limit === 0} onClick={() => set(lower)}>
        &minus;
      </button>
      <button type="button" aria-label="Allow one agent more" disabled={busy || limit === null} onClick={() => set((limit ?? 0) + 1)}>
        +
      </button>
      {limit !== null ? (
        <button type="button" aria-label="Remove the agent limit" disabled={busy} onClick={() => set(null)}>
          &infin;
        </button>
      ) : null}
      {error ? <span className="agent-limit-error">!</span> : null}
    </span>
  );
}
