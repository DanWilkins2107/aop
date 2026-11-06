import { describe, expect, it } from "vitest";
import { focusIsLost, stageChangeNotice, stillHoldsFocus } from "../../web/src/lib/panelFocus.js";

describe("keeping focus in a rebuilt panel", () => {
  const button = { isConnected: true, disabled: false };

  it("keeps focus moving within the panel, and gives it up to anything else", () => {
    expect(stillHoldsFocus("inside", button)).toBe(true);
    expect(stillHoldsFocus("outside", button)).toBe(false);
    expect(stillHoldsFocus("outside", { isConnected: false })).toBe(false);
  });

  it("keeps it when the focused button was removed or disabled while its action ran", () => {
    expect(stillHoldsFocus("nowhere", { isConnected: false })).toBe(true);
    expect(stillHoldsFocus("nowhere", { isConnected: true, disabled: true })).toBe(true);
  });

  it("gives it up when the user clicked off onto nothing focusable", () => {
    expect(stillHoldsFocus("nowhere", button)).toBe(false);
    expect(stillHoldsFocus("nowhere", { isConnected: true })).toBe(false);
  });

  it("only takes focus back when it has dropped to the page itself", () => {
    const body = {};
    expect(focusIsLost(body, body)).toBe(true);
    expect(focusIsLost(null, body)).toBe(true);
    expect(focusIsLost({}, body)).toBe(false);
  });

  it("names the new stage", () => {
    expect(stageChangeNotice("Review")).toBe("Stage changed to Review");
  });
});
