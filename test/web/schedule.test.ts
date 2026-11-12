import { describe, expect, it } from "vitest";
import type { EventView } from "../../src/shared/events/types.js";
import { scheduleToCron } from "../../src/shared/schedule/scheduleToCron.js";
import { cronToSchedule, describeSchedule, describeScheduleChange, pickerStart } from "../../web/src/lib/schedule.js";
import { describeEvent } from "../../web/src/lib/eventText.js";

describe("schedules as crons", () => {
  it("reads back the crons it builds", () => {
    for (const schedule of [
      { time: "09:30", days: [1, 3, 5] },
      { time: "23:59", days: [0, 6] },
      { time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
    ]) {
      expect(cronToSchedule(scheduleToCron(schedule))).toEqual(schedule);
    }
    expect(cronToSchedule("0 7 * * 1")).toEqual({ time: "07:00", days: [1] });
  });

  it("returns null for crons the picker couldn't have made", () => {
    for (const cron of ["*/5 * * * *", "0 9 * * MON-FRI", "0 9 1 * *", "0 9 * * 1-5", "60 9 * * 1", "0 24 * * 1", "0 9 * * 7", "@daily"]) {
      expect(cronToSchedule(cron), cron).toBeNull();
    }
  });
});

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
