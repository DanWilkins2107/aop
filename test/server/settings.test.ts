import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api.js";
import { loadConfig } from "../../src/server/config.js";
import { aopHome, configPath, resolveConfigPath } from "../../src/server/paths.js";
import { agentStartPath } from "../../src/server/projects.js";
import type { ConfigView } from "../../src/shared/api.js";
import { CONFIG_YAML, harness, makeHome, STAGES_YAML, writeFiles, type Harness } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("open_from", () => {
  const withOpenFrom = (value: string) =>
    makeHome({ "config.yaml": `agent_session_command: s\nstages: ./stages.yaml\nopen_from: ${JSON.stringify(value)}\n` });

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
    const home = makeHome({ "config.yaml": "agent_session_command: s\nstages: ./stages.yaml\n" });
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

describe("reading the config over the API", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("shows the values, the real file path and where the links resolve", async () => {
    const res = await h.call<ConfigView>("GET", "/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      config_path: configPath(),
      problems: [],
      settings: {
        agent_session_command: "sandboxed-claude",
        out_of_sandbox_command: "claude",
        open_from: "~/code",
        open_from_path: join(homedir(), "code"),
        agent_timeout_minutes: 30,
        stages: "./stages.yaml",
        stages_path: join(aopHome(), "stages.yaml"),
        improvement_stages: null,
        improvement_stages_path: null,
        improvements_path: "./skills",
        improvements_dir: join(aopHome(), "skills"),
        improvements_repo: null,
      },
    });
  });

  it("shows an unset command as null and defaults filled in", async () => {
    writeFiles(aopHome(), { "config.yaml": "agent_session_command: s\nstages: ./stages.yaml\n" });
    const { settings } = (await h.call<ConfigView>("GET", "/api/config")).body;
    expect(settings).toMatchObject({ out_of_sandbox_command: null, agent_timeout_minutes: 60 });
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
    writeFiles(aopHome(), { "config.yaml": CONFIG_YAML.replace("out_of_sandbox_command: claude", "out_of_sandbox_command: other") });
    expect((await h.call<ConfigView>("GET", "/api/config")).body.settings?.out_of_sandbox_command).toBe("other");
  });
});

describe("nothing can write the config", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

  it("refuses every write method on the config routes, leaving the files as they were", async () => {
    const before = readFileSync(configPath(), "utf8");
    const attempt = { agent_session_command: "evil", open_from: "/evil" };
    for (const method of WRITES) {
      for (const path of ["/api/config", "/api/settings", "/api/stages"]) {
        expect((await h.call(method, path, attempt)).status).toBe(404);
      }
    }
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(readFileSync(join(aopHome(), "stages.yaml"), "utf8")).toBe(STAGES_YAML);
    expect((await h.call<ConfigView>("GET", "/api/config")).body.settings?.agent_session_command).toBe("sandboxed-claude");
  });

  it("has no write route outside projects, nodes, edges, improvements, agents and runs", () => {
    const writes = createApp(h.db).routes.filter((route) => WRITES.includes(route.method));
    expect(writes.length).toBeGreaterThan(0);
    for (const { path } of writes) expect(path).toMatch(/^\/api\/(projects|nodes|edges|improvements|agents|runs)(\/|$)/);
  });

  it("gives the project routes no way in to the config", async () => {
    const before = readFileSync(configPath(), "utf8");
    const res = await h.call("PATCH", `/api/projects/${h.projectId}`, { name: "x", open_from: "/evil" });
    expect(res.status).toBe(400);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("doesn't import anything that writes files anywhere in the server, except for run logs, the server lock and applying improvements", () => {
    const READ_ONLY = new Set(["existsSync", "readdirSync", "readFileSync", "realpathSync", "statSync"]);
    const folder = join(ROOT, "src", "server");
    for (const file of readdirSync(folder)) {
      // Each writes only under AOP_HOME: the run logs, and the lock that keeps a second server off it.
      // applyProposals writes reviewed improvements, only to paths allowedTarget accepts.
      if (file === "runLog.ts" || file === "serverLock.ts" || file === "applyProposals.ts") continue;
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
