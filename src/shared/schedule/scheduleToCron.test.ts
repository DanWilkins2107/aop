import { describe, expect, it } from "vitest";
import { scheduleToCron } from "./scheduleToCron.js";

describe("scheduleToCron", () => {
  it("builds a cron from a time and days, in day order, with every day as *", () => {
    expect(scheduleToCron({ time: "09:30", days: [5, 1, 3] })).toBe("30 9 * * 1,3,5");
    expect(scheduleToCron({ time: "00:00", days: [0] })).toBe("0 0 * * 0");
    expect(scheduleToCron({ time: "03:05", days: [6, 5, 4, 3, 2, 1, 0] })).toBe("5 3 * * *");
  });

  it("lists a repeated day once", () => {
    expect(scheduleToCron({ time: "09:30", days: [1, 1, 3] })).toBe("30 9 * * 1,3");
  });
});
