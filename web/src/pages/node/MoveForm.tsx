import { useState } from "react";
import type { NodeView, StagesView } from "../../../../src/shared/api.js";
import { api } from "../../lib/api.js";
import { humanize, stageOptionGroups } from "../../lib/format.js";
import { FINISHED_STAGES } from "../../lib/stageStyle.js";
import { useAction } from "./useAction.js";

/** The stages a human can send a node to. Other built-ins have their own actions. */
function moveChoices(stages: StagesView): { group: string; options: { label: string; value: string }[] }[] {
  return [
    ...stageOptionGroups(stages),
    {
      group: "Finish",
      options: FINISHED_STAGES.map((stage) => ({ label: humanize(stage), value: JSON.stringify({ stage }) })),
    },
  ];
}

export function MoveForm({
  node,
  stages,
  primary = false,
  reload,
}: {
  node: NodeView;
  stages: StagesView;
  primary?: boolean;
  reload: () => Promise<void>;
}) {
  const [choice, setChoice] = useState("");
  const [cron, setCron] = useState("");
  const { busy, error, run } = useAction(reload);
  const parsed = choice ? (JSON.parse(choice) as { stage: string; type?: string }) : null;
  const toScheduled = parsed?.stage === "scheduled";
  const needsCron = toScheduled && node.cron === null;

  return (
    <>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!parsed) return;
          const body = toScheduled && cron.trim() !== "" ? { ...parsed, cron: cron.trim() } : parsed;
          void run(() => api.move(node.id, body)).then((ok) => {
            if (ok) {
              setChoice("");
              setCron("");
            }
          });
        }}
      >
        <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Stage to move to">
          <option value="">Choose a stage…</option>
          {moveChoices(stages).map(({ group, options }) => (
            <optgroup key={group} label={group}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {toScheduled ? (
          <input
            className="mono"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder={node.cron ?? "0 3 * * *"}
            aria-label="Cron schedule"
          />
        ) : null}
        <button type="submit" className={primary ? "btn-primary" : undefined} disabled={busy || !parsed || (needsCron && cron.trim() === "")}>
          Move
        </button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}
    </>
  );
}
