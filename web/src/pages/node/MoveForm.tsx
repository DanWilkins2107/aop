import { useState } from "react";
import type { NodeView } from "../../../../src/shared/nodes/types.js";
import type { StagesView } from "../../../../src/shared/stages/types.js";
import { FINISHED_STAGES } from "../../../../src/shared/stages/finishedStages.js";
import { api } from "../../lib/api.js";
import { FormError, useFormError } from "../../components/FormError.js";
import { humanize, stageOptionGroups } from "../../lib/format.js";
import { useAction } from "../../lib/useAction.js";

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
  reload,
}: {
  node: NodeView;
  stages: StagesView;
  reload: () => Promise<void>;
}) {
  const [choice, setChoice] = useState("");
  const { busy, error, run } = useAction(reload);
  const { errorId, describedBy } = useFormError(error);
  const parsed = choice ? (JSON.parse(choice) as { stage: string; type?: string }) : null;

  return (
    <>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!parsed) return;
          void run(() => api.move(node.id, parsed)).then((ok) => {
            if (ok) setChoice("");
          });
        }}
      >
        <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Stage to move to" aria-describedby={describedBy}>
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
        <button type="submit" disabled={busy || !parsed}>
          Move
        </button>
      </form>
      <FormError error={error} id={errorId} />
    </>
  );
}
