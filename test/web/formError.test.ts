import { describe, expect, it } from "vitest";
import { errorReference } from "../../web/src/lib/formError.js";

describe("tying a form's error to its fields", () => {
  it("points at the error while one is shown", () => {
    expect(errorReference("Name is taken", "err-1")).toBe("err-1");
  });

  it("points at nothing when there's no error", () => {
    expect(errorReference(null, "err-1")).toBeUndefined();
    expect(errorReference("", "err-1")).toBeUndefined();
  });
});
