import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { World } from "../../../test-shared/agents.js";
import { aopOn, cliWorld } from "../test-shared/cli.helpers.js";

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

it("project add registers a path", async () => {
  const res = await aopOn(w, ["project", "add", w.home]);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("Added project");
  expect((await aopOn(w, ["project", "add", join(w.home, "nope")])).code).toBe(1);
});
