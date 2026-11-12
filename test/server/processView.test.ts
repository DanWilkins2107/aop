import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessView } from "../../src/shared/stages/types.js";
import { harness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.close());

const processView = async () => {
  const res = await h.call<ProcessView>("GET", "/api/process");
  expect(res.status).toBe(200);
  return res.body;
};

describe("GET /api/process", () => {
  it("describes every type and where stages.yaml is", async () => {
    const view = await processView();
    expect(view.problems).toEqual([]);
    expect(view.stages_path).toMatch(/stages\.yaml$/);
    expect(view.process?.start).toBe("triage");
    expect(view.process?.types.map((t) => t.name)).toEqual(["triage", "dev", "hotfix", "nightly"]);
    expect(view.process?.types.find((t) => t.name === "nightly")?.stages).toEqual([
      { name: "scheduled", next: [{ outcome: "fire", target: "triage" }] },
    ]);
  });

  it("still answers when stages.yaml is invalid, with the problems and what could be read", async () => {
    h.rewriteStages(`
start: work
stages:
  review: { turn: human }
types:
  work:
    start: review
    stages:
      review: { next: { ok: nowhere } }
`);
    const view = await processView();
    expect(view.problems.join("\n")).toContain('targets "nowhere"');
    expect(view.process?.types.map((t) => t.name)).toEqual(["work"]);
    // The strict endpoint refuses, which is why the page doesn't use it.
    expect((await h.call("GET", "/api/stages")).status).not.toBe(200);
  });

  it("still answers when stages.yaml isn't YAML at all", async () => {
    h.rewriteStages("start: [unclosed\n");
    const view = await processView();
    expect(view.problems.length).toBeGreaterThan(0);
    expect(view.process).toBeNull();
    expect(view.stages_path).toMatch(/stages\.yaml$/);
  });
});
