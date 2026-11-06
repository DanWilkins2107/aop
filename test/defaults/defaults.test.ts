import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../../src/server/config.js";
import { aopHome } from "../../src/server/paths.js";
import { nodeArgs, ROOT } from "../server/agents.helpers.js";

const DEFAULTS = join(ROOT, "defaults");
const PLUGIN = join(ROOT, "plugin");

/** The shipped defaults, copied into a fresh AOP home as `aop init` will. */
function installDefaults(): string {
  const home = mkdtempSync(join(aopHome(), "defaults-"));
  cpSync(DEFAULTS, home, { recursive: true });
  return home;
}

function markdownFiles(): string[] {
  const skills = readdirSync(join(PLUGIN, "skills")).map((name) => join(PLUGIN, "skills", name, "SKILL.md"));
  const prompts = readdirSync(join(DEFAULTS, "prompts")).map((name) => join(DEFAULTS, "prompts", name));
  return [...skills, ...prompts, join(PLUGIN, "README.md")];
}

/** Commands whose second word picks the action, such as `aop node create`. */
const WITH_ACTION = new Set(["node", "edge", "split", "link", "project"]);

function commandKeys(tokens: string[]): string[] {
  const [command, action] = tokens;
  if (command === undefined) return [];
  if (!WITH_ACTION.has(command) || action === undefined || action.startsWith("<")) return [command];
  return action.split("|").map((a) => `${command} ${a}`);
}

const tokensOf = (text: string) => text.replaceAll("\\|", "|").trim().split(/\s+/).slice(1);

describe("the default improvement pipeline", () => {
  type Stages = { stages: Record<string, { color?: string }> } & Record<string, unknown>;
  const withoutColours = (file: Stages) => ({
    ...file,
    stages: Object.fromEntries(Object.entries(file.stages).map(([name, { color: _color, ...stage }]) => [name, stage])),
  });

  it("matches specs/improvements.md, and the demo's copy matches it", () => {
    const spec = readFileSync(join(ROOT, "specs", "improvements.md"), "utf8").replaceAll("\r\n", "\n");
    const example = [...spec.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!).find((text) => text.includes("types:"));
    const shipped = parse(readFileSync(join(DEFAULTS, "improvement_stages.yaml"), "utf8")) as Stages;
    expect(withoutColours(shipped)).toEqual(withoutColours(parse(example ?? "") as Stages));
    expect(readFileSync(join(ROOT, "demo", "config", "improvement_stages.yaml"), "utf8")).toBe(
      readFileSync(join(DEFAULTS, "improvement_stages.yaml"), "utf8"),
    );
  });

  it("loads with the shipped config, starting in the skills folder", () => {
    const home = installDefaults();
    const config = loadConfig(home);
    expect(config.improvementGraph?.types.get("improvement")?.start).toBe("draft_change");
    expect(config.improvementsDir).toBe(join(home, "skills"));
  });
});

describe("shipped defaults", () => {
  it("pass the real config and stages validators", () => {
    const config = loadConfig(installDefaults());
    expect([...config.graph.types.keys()]).toEqual(["triage", "dev"]);
    for (const [, stage] of config.graph.stages) if (stage.turn === "agent") expect(stage.prompt).toBeDefined();
  });

  it("have no scheduled type", () => {
    const config = loadConfig(installDefaults());
    for (const [, type] of config.graph.types) {
      expect(type.start).not.toBe("scheduled");
      expect(type.stages.has("scheduled")).toBe(false);
    }
  });

  it("have a prompt for every agent stage and nothing else", () => {
    const config = loadConfig(installDefaults());
    const pools = [...config.graph.stages, ...(config.improvementGraph?.stages ?? [])];
    const agentStages = pools.filter(([, s]) => s.turn === "agent").map(([name]) => `${name}.md`);
    expect(readdirSync(join(DEFAULTS, "prompts")).sort()).toEqual(agentStages.sort());
  });
});

describe("plugin and prompts", () => {
  const help = spawnSync(process.execPath, [...nodeArgs("src/cli/main.ts"), "help"], { encoding: "utf8" });
  const usage = help.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("aop "));
  const known = new Map<string, string[]>();
  for (const line of usage) for (const key of commandKeys(tokensOf(line))) known.set(key, [...(known.get(key) ?? []), line]);

  it("reads the CLI's usage", () => {
    expect(help.status).toBe(0);
    expect(known.size).toBeGreaterThan(10);
  });

  it("only name aop commands and flags the CLI has", () => {
    const mentions = markdownFiles().flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/`(aop [^`]+)`/g)].map((m) => ({ file, text: m[1]! })),
    );
    expect(mentions.length).toBeGreaterThan(20);
    for (const { file, text } of mentions) {
      const tokens = tokensOf(text);
      for (const key of commandKeys(tokens)) {
        const lines = known.get(key);
        expect(lines, `${file}: \`${text}\` isn't a command`).toBeDefined();
        for (const flag of tokens.filter((t) => t.startsWith("--"))) {
          const name = flag.replace(/[^-\w].*$/, "");
          expect(lines!.some((l) => l.includes(name)), `${file}: \`${text}\` uses unknown flag ${name}`).toBe(true);
        }
      }
    }
  });

  it("have valid manifests", () => {
    for (const file of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".github/plugin/plugin.json"]) {
      const manifest = JSON.parse(readFileSync(join(PLUGIN, file), "utf8")) as { name: string };
      expect(manifest.name).toBe("aop");
    }
  });

  it("give every skill a name matching its folder and a description", () => {
    for (const name of readdirSync(join(PLUGIN, "skills"))) {
      const text = readFileSync(join(PLUGIN, "skills", name, "SKILL.md"), "utf8");
      expect(text).toMatch(new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .+\\r?\\n---\\r?\\n`));
    }
  });
});
