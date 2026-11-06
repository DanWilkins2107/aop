import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_TURN_STAGES,
  BUILT_IN_STAGES,
  FINISHED_STAGES,
  GLOBAL_STAGES,
  HUMAN_TURN_STAGES,
} from "../../src/shared/builtInStages.js";

const spec = readFileSync(new URL("../../specs/built-in-stages.md", import.meta.url), "utf8");

/** The spec's table rows, as stage name to "Who acts". */
const whoActs = new Map(
  [...spec.matchAll(/^\| `([a-z_]+)` \| ([^|]+?) \|/gm)].map((m) => [m[1]!, m[2]!.trim()] as const),
);

const stagesActedBy = (who: string) => [...whoActs].filter(([, actor]) => actor === who).map(([stage]) => stage);

const backticked = (text: string) => [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);

describe("built-in stages agree with specs/built-in-stages.md", () => {
  it("names the same built-ins", () => {
    expect([...whoActs.keys()].sort()).toEqual([...BUILT_IN_STAGES].sort());
  });

  it("has the same global stages", () => {
    const line = spec.split("\n").find((l) => l.startsWith("**Global stages**"));
    expect(line).toBeDefined();
    expect(backticked(line!).sort()).toEqual([...GLOBAL_STAGES].sort());
  });

  it("has the same finished stages, which are the only next targets", () => {
    const finished = [...spec.matchAll(/^- \*\*`([a-z_]+)`:\*\* finished\./gm)].map((m) => m[1]!);
    expect(finished.sort()).toEqual([...FINISHED_STAGES].sort());

    const nextTargets = spec.split("\n").find((l) => l.startsWith("Only ") && l.includes("`next` targets"));
    expect(nextTargets).toBeDefined();
    const firstSentence = nextTargets!.split(". ")[0]!;
    expect(backticked(firstSentence).filter((s) => s !== "next").sort()).toEqual([...FINISHED_STAGES].sort());
  });

  it("gives the human and the agent the same built-ins", () => {
    expect(stagesActedBy("Human").sort()).toEqual([...HUMAN_TURN_STAGES].sort());
    expect(stagesActedBy("Agent").sort()).toEqual([...AGENT_TURN_STAGES].sort());
  });
});
