import { readFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { directives, until, type World } from "../../../test/server/agents.helpers.js";
import { aopOn, cliWorld, parked } from "../shared/cli.helpers.js";

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

it("logs prints the end of the latest run's log", async () => {
  const fresh = await parked(w);
  const none = await aopOn(w, ["logs", fresh.id]);
  expect(none.code).toBe(1);
  expect(none.stderr).toContain("no runs yet");

  const node = await w.create(directives(...Array.from({ length: 60 }, (_, i) => `say line ${i + 1}`), "hang"));
  await w.runStarted(node.id);
  await until("the log is written", () => (readFileSync(w.runs(node.id)[0]!.log_path, "utf8").includes("line 60") ? true : null));

  const defaults = await aopOn(w, ["logs", node.id]);
  expect(defaults.code).toBe(0);
  expect(defaults.stdout).toContain("line 60");
  expect(defaults.stdout).toContain("line 11\n");
  expect(defaults.stdout).not.toContain("line 10\n");

  const three = await aopOn(w, ["logs", node.id, "--lines", "3"]);
  expect(three.stdout.trimEnd().split(/\r?\n/)).toEqual(["line 58", "line 59", "line 60"]);

  for (const bad of ["0", "-2", "x", "1.5"]) {
    const res = await aopOn(w, ["logs", node.id, "--lines", bad]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--lines");
  }
  expect((await aopOn(w, ["logs"], { node: node.id })).code).toBe(2);
});
