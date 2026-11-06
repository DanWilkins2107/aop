import { describe, expect, it } from "vitest";
import { wrappedFocus } from "../../web/src/lib/focusTrap.js";

describe("dialog focus trap", () => {
  const controls = ["name", "path", "cancel", "submit"];

  it("wraps Tab from the last control to the first, and Shift+Tab back", () => {
    expect(wrappedFocus(controls, "submit", false)).toBe("name");
    expect(wrappedFocus(controls, "name", true)).toBe("submit");
  });

  it("leaves moves between controls to the browser", () => {
    expect(wrappedFocus(controls, "name", false)).toBeNull();
    expect(wrappedFocus(controls, "submit", true)).toBeNull();
    expect(wrappedFocus(controls, "path", true)).toBeNull();
  });

  it("brings focus back in from outside, such as a control that went disabled while saving", () => {
    expect(wrappedFocus(controls, null, false)).toBe("name");
    expect(wrappedFocus(controls, "page link", false)).toBe("name");
    expect(wrappedFocus(controls, "page link", true)).toBe("submit");
  });

  it("does nothing with nothing to focus", () => {
    expect(wrappedFocus([], null, false)).toBeNull();
  });
});
