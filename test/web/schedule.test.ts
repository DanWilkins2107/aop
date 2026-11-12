import { describe, expect, it } from "vitest";
import type { EventView } from "../../src/shared/api/types.js";
import { describeEvent } from "../../web/src/lib/eventText.js";
import { describeSchedule, describeScheduleChange, pickerStart } from "../../web/src/lib/schedule.js";

describe("schedule wording", () => {
  it("says when a node fires, or that it won't", () => {
    expect(describeSchedule("30 9 * * 1,3,5")).toBe("Fires at 09:30 on Mon, Wed, Fri.");
    expect(describeSchedule("0 3 * * *")).toBe("Every day at 03:00.");
    // Monday first, so Sunday comes last.
    expect(describeSchedule("0 8 * * 0,6")).toBe("Fires at 08:00 on Sat, Sun.");
    expect(describeSchedule(null)).toBe("No schedule: this node won't fire.");
    expect(describeSchedule("*/5 * * * *")).toBe("Fires on the cron */5 * * * *.");
  });

  it("describes schedule changes in the history", () => {
    expect(describeScheduleChange("30 9 * * 1,3")).toBe("Schedule set: 09:30 on Mon, Wed");
    expect(describeScheduleChange("0 3 * * *")).toBe("Schedule set: every day at 03:00");
    expect(describeScheduleChange(null)).toBe("Schedule cleared");
    const event = (data: unknown): EventView => ({ id: "e", created_at: "", node_id: "n", actor: "human", kind: "schedule_changed", data });
    expect(describeEvent(event({ cron: "30 9 * * 1,3", previous: null }), String)).toBe("Schedule set: 09:30 on Mon, Wed");
    expect(describeEvent(event({ cron: null, previous: "0 3 * * *" }), String)).toBe("Schedule cleared");
  });

  it("starts the picker from the node's schedule, or weekdays at 09:00", () => {
    expect(pickerStart("30 9 * * 1,3")).toEqual({ time: "09:30", days: [1, 3] });
    expect(pickerStart(null)).toEqual({ time: "09:00", days: [1, 2, 3, 4, 5] });
    expect(pickerStart("*/5 * * * *")).toEqual({ time: "09:00", days: [1, 2, 3, 4, 5] });
  });
});
