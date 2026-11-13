import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUMAN_COMMANDS } from "../../src/cli/commands/registry.js";
import { TOOLS } from "../../src/mcp/tools/registry.js";
import { loadConfig } from "../../src/server/config.js";
import { aopHome } from "../../src/server/paths.js";
import { ROOT } from "../server/agents.helpers.js";

const DEFAULTS = join(ROOT, "defaults");
const PLUGIN = join(ROOT, "plugin");

/** The shipped defaults, copied into a fresh AOP home as `aop init` will. */
function installDefaults(): string {
  const home = mkdtempSync(join(aopHome(), "defaults-"));
  cpSync(DEFAULTS, home, { recursive: true });
  return home;
}

/** What agents read: the skills and the stage prompts. */
function agentFiles(): string[] {
  const skills = readdirSync(join(PLUGIN, "skills")).map((name) => join(PLUGIN, "skills", name, "SKILL.md"));
  const prompts = readdirSync(join(DEFAULTS, "prompts")).map((name) => join(DEFAULTS, "prompts", name));
  return [...skills, ...prompts];
}

const markdownFiles = () => [...agentFiles(), join(PLUGIN, "README.md")];

const aopMentions = (files: string[]) =>
  files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/`(aop [^`]+)`/g)].map((m) => ({ file, text: m[1]! })));

/** The only commands agents may name, all a human's: agents use the MCP tools, and only tell a human about these. */
const AGENTS_MAY_NAME = new Set(["steer"]);

/** Commands whose second word picks the action, such as `aop project add`. */
const WITH_ACTION = new Set(["project"]);

function commandKeys(tokens: string[]): string[] {
  const [command, action] = tokens;
  if (command === undefined) return [];
  if (!WITH_ACTION.has(command) || action === undefined || action.startsWith("<")) return [command];
  return action.split("|").map((a) => `${command} ${a}`);
}

const tokensOf = (text: string) => text.replaceAll("\\|", "|").trim().split(/\s+/).slice(1);

describe("the default improvement pipeline", () => {
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
    expect([...config.graph.types.keys()]).toEqual(["triage", "dev", "decisions"]);
    for (const [, stage] of config.graph.stages) if (stage.turn === "agent") expect(stage.prompt).toBeDefined();
  });

  it("have no scheduled type", () => {
    const config = loadConfig(installDefaults());
    expect([...config.graph.types.values()].some((type) => type.stages.has("scheduled"))).toBe(false);
  });

  it("start decisions with an agent's summary, go between a human's decision and an agent's clarification, and triage can route there", () => {
    const config = loadConfig(installDefaults());
    const decisions = config.graph.types.get("decisions")!;
    expect(decisions.start).toBe("awaiting_agent_summary");
    expect(Object.fromEntries([...decisions.stages].map(([stage, next]) => [stage, Object.fromEntries(next)]))).toEqual({
      awaiting_agent_summary: { summarised: "decision" },
      decision: { decided: "done", clarify: "awaiting_agent_clarification", retriage: "triage" },
      awaiting_agent_clarification: { clarified: "decision" },
    });
    expect(config.graph.stages.get("awaiting_agent_summary")?.turn).toBe("agent");
    expect(config.graph.stages.get("decision")?.turn).toBe("human");
    expect(config.graph.stages.get("awaiting_agent_clarification")?.turn).toBe("agent");
    expect(config.graph.types.get("triage")?.stages.get("awaiting_agent_breakdown")?.get("decision")).toBe("decisions");
    expect(config.graph.types.get("triage")?.stages.get("human_only_action")?.get("retriage")).toBe("triage");
  });

  it("let a human ask about a human-only action and get it back once an agent clarifies", () => {
    const triage = loadConfig(installDefaults()).graph.types.get("triage")!;
    expect(Object.fromEntries(triage.stages.get("human_only_action")!)).toEqual({
      done: "done",
      clarify: "awaiting_agent_clarification",
      retriage: "triage",
    });
    expect(Object.fromEntries(triage.stages.get("awaiting_agent_clarification")!)).toEqual({ clarified: "human_only_action" });
  });

  it("have a prompt for every agent stage and nothing else", () => {
    const config = loadConfig(installDefaults());
    const pools = [...config.graph.stages, ...(config.improvementGraph?.stages ?? [])];
    const agentStages = pools.filter(([, s]) => s.turn === "agent").map(([name]) => `${name}.md`);
    expect(readdirSync(join(DEFAULTS, "prompts")).sort()).toEqual(agentStages.sort());
  });
});

describe("plugin and prompts", () => {
  // Every command's usage, as the CLI's help lists it.
  const known = new Map<string, string[]>();
  for (const line of Object.values(HUMAN_COMMANDS).flat()) {
    for (const key of commandKeys(tokensOf(line))) known.set(key, [...(known.get(key) ?? []), line]);
  }

  it("reads the CLI's usage", () => {
    expect(known.size).toBeGreaterThan(5);
  });

  it("only name aop commands and flags the CLI has", () => {
    const mentions = aopMentions(markdownFiles());
    expect(mentions.length).toBeGreaterThan(0);
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

  it("never tell agents to run an aop command, only name the human ones agents tell a human about", () => {
    for (const { file, text } of aopMentions(agentFiles())) {
      for (const key of commandKeys(tokensOf(text))) expect(AGENTS_MAY_NAME, `${file}: \`${text}\``).toContain(key);
    }
  });

  // The text always names an MCP tool as "the `next` tool": a backticked name, then "tool".
  it("only name MCP tools the server has, each as `<name>` tool", () => {
    const tools = new Set(TOOLS.map((t) => t.name));
    const texts = markdownFiles().map((file) => ({ file, text: readFileSync(file, "utf8") }));
    const mentions = texts.flatMap(({ file, text }) => [...text.matchAll(/`([a-z_]+)` tools?\b/g)].map((m) => ({ file, name: m[1]! })));
    expect(mentions.length).toBeGreaterThan(5);
    for (const { file, name } of mentions) expect(tools, `${file}: \`${name}\` tool isn't an MCP tool`).toContain(name);
    // A tool's bare name would slip past the check above.
    const bare = texts.flatMap(({ file, text }) =>
      [...tools].filter((name) => new RegExp(`\`${name}\`(?! tool)`).test(text)).map((name) => `${file}: \`${name}\``),
    );
    expect(bare, 'write a tool as "the `<name>` tool"').toEqual([]);
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
