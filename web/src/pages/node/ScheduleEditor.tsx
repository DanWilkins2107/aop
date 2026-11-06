import { useState } from "react";
import type { NodeView } from "../../../../src/shared/api.js";
import { cronToSchedule, scheduleToCron } from "../../../../src/shared/schedule.js";
import { FormError, useFormError } from "../../components/FormError.js";
import { api } from "../../lib/api.js";
import { describeSchedule, pickerStart, WEEK } from "../../lib/schedule.js";
import { useAction } from "../../lib/useAction.js";

const nextFire = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A scheduled node's own schedule: a time and the days to fire on, or none. */
function Editor({ node, reload }: { node: NodeView; reload: () => Promise<void> }) {
  const start = pickerStart(node.cron);
  const [time, setTime] = useState(start.time);
  const [days, setDays] = useState<number[]>(start.days);
  const { busy, error, run } = useAction(reload);
  const { errorId, describedBy } = useFormError(error);
  const fitsPicker = node.cron === null || cronToSchedule(node.cron) !== null;
  const valid = /^\d\d:\d\d$/.test(time) && days.length > 0;
  const unchanged = valid && node.cron === scheduleToCron({ time, days });

  const toggle = (day: number) => setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));

  return (
    <div>
      <p className="action-text">
        Stays here and creates a child each time it fires. {describeSchedule(node.cron)}
        {node.next_fire_at ? <span className="muted"> Next: {nextFire(node.next_fire_at)}.</span> : null}
      </p>
      <form
        className="schedule-form"
        aria-label="Schedule"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void run(() => api.setSchedule(node.id, { time, days }));
        }}
      >
        <label className="schedule-time">
          Time (server time)
          <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} aria-describedby={describedBy} />
        </label>
        <fieldset className="schedule-days">
          <legend>Days</legend>
          <div className="schedule-day-row">
            {WEEK.map(({ day, short, long }) => (
              <button
                key={day}
                type="button"
                className="btn-small day-toggle"
                aria-pressed={days.includes(day)}
                aria-label={long}
                onClick={() => toggle(day)}
              >
                {short}
              </button>
            ))}
          </div>
        </fieldset>
        {days.length === 0 ? <p className="field-hint">Pick at least one day.</p> : null}
        {!fitsPicker ? <p className="field-hint">Saving replaces the cron above.</p> : null}
        <div className="action-row">
          <button type="submit" className="btn-small" disabled={busy || !valid || unchanged}>
            Save schedule
          </button>
          <button
            type="button"
            className="btn-small"
            disabled={busy || node.cron === null}
            onClick={() => void run(() => api.setSchedule(node.id, null))}
          >
            Clear
          </button>
        </div>
      </form>
      <FormError error={error} id={errorId} />
    </div>
  );
}

/** Starts afresh from the stored schedule whenever it changes, such as after a save. */
export function ScheduleEditor(props: { node: NodeView; reload: () => Promise<void> }) {
  return <Editor key={props.node.cron ?? ""} {...props} />;
}
