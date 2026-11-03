import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createApp } from "../../src/server/api.js";
import { loadConfig } from "../../src/server/config.js";
import { aopHome, configPath, resolveConfigPath } from "../../src/server/paths.js";
import { agentStartPath } from "../../src/server/projects.js";
import type { ConfigView } from "../../src/shared/api.js";
import { CONFIG_YAML, harness, makeHome, STAGES_YAML, writeFiles, type Harness } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("open_from", () => {
  const withOpenFrom = (value: string) =>
    makeHome({ "config.yaml": `sandboxed_command: s\nstages: ./stages.yaml\nopen_from: ${JSON.stringify(value)}\n` });

  it("takes an absolute path as written", () => {
    const absolute = resolve("/somewhere/else");
    expect(loadConfig(withOpenFrom(absolute))).toMatchObject({ open_from: absolute, openFromPath: absolute });
  });

  it("expands ~ to the user's home", () => {
    expect(loadConfig(withOpenFrom("~")).openFromPath).toBe(homedir());
    expect(loadConfig(withOpenFrom("~/code")).openFromPath).toBe(join(homedir(), "code"));
    expect(loadConfig(withOpenFrom("~\\code")).openFromPath).toBe(join(homedir(), "code"));
  });

  it("resolves a relative path from the config's folder, the same as stages", () => {
    const home = withOpenFrom("./work");
    expect(loadConfig(home).openFromPath).toBe(join(home, "work"));
  });

  it("defaults to ~/code, which doesn't have to exist", () => {
    const home = makeHome({ "config.yaml": "sandboxed_command: s\nstages: ./stages.yaml\n" });
    expect(loadConfig(home)).toMatchObject({ open_from: "~/code", openFromPath: join(homedir(), "code") });
  });

  it("only treats a whole ~ segment as home", () => {
    expect(resolveConfigPath("/base", "~other")).toBe(resolve("/base", "~other"));
  });
});

describe("where a project's agents start", () => {
  const config = { openFromPath: resolve("/default") };

  it("is the project's path when it has one", () => {
    expect(agentStartPath({ repo_path: resolve("/repo") }, config)).toBe(resolve("/repo"));
  });

  it("is open_from when it doesn't", () => {
    expect(agentStartPath({ repo_path: null }, config)).toBe(resolve("/default"));
  });
});

describe("the demo's process", () => {
  type Stages = { stages: Record<string, { color?: string }> } & Record<string, unknown>;

  /** The file's meaning, leaving out colours, which the demo chooses for itself. */
  const withoutColours = (stages: Stages) => ({
    ...stages,
    stages: Object.fromEntries(
      Object.entries(stages.stages).map(([name, { color: _color, ...stage }]) => [name, stage]),
    ),
  });

  it("matches the example in specs/stages.md", () => {
    const spec = readFileSync(join(ROOT, "specs", "stages.md"), "utf8");
    const example = /```yaml\n([\s\S]*?)```/.exec(spec.replaceAll("\r\n", "\n"))?.[1] ?? "";
    const demo = readFileSync(join(ROOT, "demo", "config", "stages.yaml"), "utf8");
    expect(withoutColours(parse(demo) as Stages)).toEqual(withoutColours(parse(example) as Stages));
  });

  it("starts new nodes on the renamed stage, with its prompt file", () => {
    const graph = loadConfig(join(ROOT, "demo", "config")).graph;
    expect(graph.types.get("triage")?.start).toBe("awaiting_agent_breakdown");
    expect(readdirSync(join(ROOT, "demo", "config", "prompts"))).toContain("awaiting_agent_breakdown.md");
    expect(readdirSync(join(ROOT, "demo", "config", "prompts"))).not.toContain("assess.md");
  });
});

describe("reading the config over the API", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.close());

  it("shows the values, the real file path and where the links resolve", async () => {
    const res = await h.call<ConfigView>("GET", "/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      config_path: configPath(),
      problems: [],
      settings: {
        sandboxed_command: "sandboxed-claude",
        non_sandboxed_command: "claude",
        agent_args: "-p",
        sandbox: true,
        open_from: "~/code",
        open_from_path: join(homedir(), "code"),
        agent_timeout_minutes: 30,
        stages: "./stages.yaml",
        stages_path: join(aopHome(), "stages.yaml"),
      },
    });
  });

  it("shows an unset command as null and defaults filled in", async () => {
    writeFiles(aopHome(), { "config.yaml": "sandboxed_command: s\nstages: ./stages.yaml\n" });
    const { settings } = (await h.call<ConfigView>("GET", "/api/config")).body;
    expect(settings).toMatchObject({ non_sandboxed_command: null, agent_args: "", agent_timeout_minutes: 60 });
  });

  it("still answers while the config is invalid, listing the problems", async () => {
    h.rewriteStages("not: valid\n");
    const res = await h.call<ConfigView>("GET", "/api/config");
    expect(res.status).toBe(200);
    expect(res.body.config_path).toBe(configPath());
    expect(res.body.settings).toBeNull();
    expect(res.body.problems.length).toBeGreaterThan(0);
  });

  it("re-reads the file each time", async () => {
    writeFiles(aopHome(), { "config.yaml": CONFIG_YAML.replace("agent_args: -p", "agent_args: --print") });
    expect((await h.call<ConfigView>("GET", "/api/config")).body.settings?.agent_args).toBe("--print");
  });
});

describe("nothing can write the config", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.close());

  const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

  it("refuses every write method on the config routes, leaving the files as they were", async () => {
    const before = readFileSync(configPath(), "utf8");
    const attempt = { sandbox: false, sandboxed_command: "evil", open_from: "/evil" };
    for (const method of WRITES) {
      for (const path of ["/api/config", "/api/config/sandbox", "/api/settings", "/api/stages"]) {
        expect((await h.call(method, path, attempt)).status).toBe(404);
      }
    }
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(readFileSync(join(aopHome(), "stages.yaml"), "utf8")).toBe(STAGES_YAML);
    expect((await h.call<ConfigView>("GET", "/api/config")).body.settings?.sandbox).toBe(true);
  });

  it("has no write route outside projects, nodes and edges", () => {
    const writes = createApp(h.db).routes.filter((route) => WRITES.includes(route.method));
    expect(writes.length).toBeGreaterThan(0);
    for (const { path } of writes) expect(path).toMatch(/^\/api\/(projects|nodes|edges)(\/|$)/);
  });

  it("gives the project routes no way in to the config", async () => {
    const before = readFileSync(configPath(), "utf8");
    const res = await h.call("PATCH", `/api/projects/${h.projectId}`, { name: "x", open_from: "/evil" });
    expect(res.status).toBe(400);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("doesn't import anything that writes files anywhere in the server", () => {
    const READ_ONLY = new Set(["existsSync", "readFileSync", "realpathSync", "statSync"]);
    const folder = join(ROOT, "src", "server");
    for (const file of readdirSync(folder)) {
      const source = readFileSync(join(folder, file), "utf8");
      expect(source, file).not.toMatch(/from "(node:)?fs\/promises"/);
      for (const [, names] of source.matchAll(/import \{([^}]*)\} from "(?:node:)?fs"/g)) {
        for (const name of (names ?? "").split(",").map((n) => n.trim()).filter(Boolean)) {
          expect(READ_ONLY.has(name), `${file} imports ${name}`).toBe(true);
        }
      }
      expect(source, file).not.toMatch(/import \* as \w+ from "(node:)?fs"/);
    }
  });
});
