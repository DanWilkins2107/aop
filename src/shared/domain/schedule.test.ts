import { describe, expect, it } from "vitest";
import { cronToSchedule, scheduleToCron } from "./schedule.js";

describe("schedules as crons", () => {
  it("builds a cron from a time and days, in day order, with every day as *", () => {
    expect(scheduleToCron({ time: "09:30", days: [5, 1, 3] })).toBe("30 9 * * 1,3,5");
    expect(scheduleToCron({ time: "00:00", days: [0] })).toBe("0 0 * * 0");
    expect(scheduleToCron({ time: "03:05", days: [6, 5, 4, 3, 2, 1, 0] })).toBe("5 3 * * *");
  });

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
