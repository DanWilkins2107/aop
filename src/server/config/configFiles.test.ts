import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigFileView } from "../../shared/config/types.js";
import { CONFIG_YAML, harness, STAGES_YAML, type Harness } from "../../../test-shared/harness.js";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.close());

const home = () => process.env["AOP_HOME"] ?? "";
const files = async () => (await h.call<ConfigFileView[]>("GET", "/api/config/files")).body;
const save = (path: string, content: string, base: string | null) =>
  h.call<ConfigFileView & { error: { code: string; message: string; details?: unknown } }>("PUT", "/api/config/files", {
    path,
    content,
    base,
  });

describe("GET /api/config/files", () => {
  it("lists config.yaml, the process file and its prompts, with their contents", async () => {
    const listed = await files();
    expect(listed.map((f) => [f.kind, f.path])).toEqual([
      ["config", join(home(), "config.yaml")],
      ["stages", join(home(), "stages.yaml")],
      ...["awaiting_agent_breakdown", "split_approved", "write_spec", "implement"].map((p) => [
        "prompt",
        join(home(), "prompts", `${p}.md`),
      ]),
    ]);
    expect(listed[0]?.content).toBe(CONFIG_YAML);
  });

  it("still lists config.yaml when it isn't YAML, so it can be fixed", async () => {
    writeFileSync(join(home(), "config.yaml"), "stages: [unclosed\n");
    expect((await files()).map((f) => f.kind)).toEqual(["config"]);
  });
});

describe("PUT /api/config/files", () => {
  it("saves a valid config.yaml, and the settings show it", async () => {
    const path = join(home(), "config.yaml");
    const edited = CONFIG_YAML.replace("agent_timeout_minutes: 30", "agent_timeout_minutes: 45");
    const res = await save(path, edited, CONFIG_YAML);
    expect(res.status).toBe(200);
    expect(readFileSync(path, "utf8")).toBe(edited);
    const config = await h.call<{ settings: { agent_timeout_minutes: number } }>("GET", "/api/config");
    expect(config.body.settings.agent_timeout_minutes).toBe(45);
  });

  it("refuses invalid settings and writes nothing", async () => {
    const path = join(home(), "config.yaml");
    const res = await save(path, CONFIG_YAML + "agent_timeout_minutes_typo: 1\n", CONFIG_YAML);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toContain("agent_timeout_minutes_typo");
    expect(readFileSync(path, "utf8")).toBe(CONFIG_YAML);
  });

  it("refuses a process file with problems", async () => {
    const path = join(home(), "stages.yaml");
    const res = await save(path, STAGES_YAML.replace("start: triage", "start: nowhere"), STAGES_YAML);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(['stages.yaml: start "nowhere" is not a type']);
    expect(readFileSync(path, "utf8")).toBe(STAGES_YAML);
  });

  it("saves a prompt, and creates one that's missing", async () => {
    const path = join(home(), "prompts", "implement.md");
    expect((await save(path, "Build it.", "Do implement.")).status).toBe(200);
    expect(readFileSync(path, "utf8")).toBe("Build it.");
  });

  it("refuses when the file changed since it was shown", async () => {
    const path = join(home(), "stages.yaml");
    const res = await save(path, STAGES_YAML, "something older");
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("has changed since it was shown");
  });

  it("refuses any other file", async () => {
    const res = await save(join(home(), "aop.db"), "x", null);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("path_not_allowed");
  });

  it("never writes inside a project's folder", async () => {
    const own = join(h.repo, "process.yaml");
    const edited = `${CONFIG_YAML}project_stages:\n  ${h.projectId}: ${JSON.stringify(own)}\n`;
    expect((await save(join(home(), "config.yaml"), edited, CONFIG_YAML)).status).toBe(200);
    const res = await save(own, STAGES_YAML, null);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("never writes to");
  });
});
