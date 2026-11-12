import { describe, expect, it } from "vitest";
import { isBuiltIn } from "./isBuiltIn.js";

describe("isBuiltIn", () => {
  it("knows the built-in stages from a process's own", () => {
    expect(isBuiltIn("done")).toBe(true);
    expect(isBuiltIn("splitting")).toBe(true);
    expect(isBuiltIn("implement")).toBe(false);
  });

  it("isn't fooled by names every object has", () => {
    expect(isBuiltIn("toString")).toBe(false);
    expect(isBuiltIn("constructor")).toBe(false);
  });
});
