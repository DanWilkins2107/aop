import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { configPath, resolveConfigPath } from "../../../server/paths.js";
import { loadStagesFile, promptFiles } from "../../../server/stages.js";
import { parseYamlFile } from "../../../server/yamlFile.js";

/** The default improvement pipeline's files, relative to `defaults/`. */
function improvementDefaults(defaults: string): string[] {
  const { graph } = loadStagesFile(join(defaults, "improvement_stages.yaml"));
  return ["improvement_stages.yaml", ...promptFiles(graph).map((prompt) => join("prompts", basename(prompt)))];
}

/**
 * Copies a default process from the package into `home`, skipping any file already there: the work
 * process, the improvement pipeline, or both.
 */
export function copyDefaults(packageRoot: string, home: string, say: (text: string) => void, which: { work: boolean; improvements: boolean }): void {
  const defaults = join(packageRoot, "defaults");
  const improvementFiles = improvementDefaults(defaults);
  const workFiles = ["stages.yaml", ...readdirSync(join(defaults, "prompts")).map((name) => join("prompts", name))].filter(
    (file) => !improvementFiles.includes(file),
  );
  const files = [...(which.work ? workFiles : []), ...(which.improvements ? improvementFiles : [])];
  mkdirSync(join(home, "prompts"), { recursive: true });
  for (const file of files) {
    const target = join(home, file);
    if (existsSync(target)) {
      say(`Kept ${target}`);
      continue;
    }
    copyFileSync(join(defaults, file), target);
    say(`Wrote ${target}`);
  }
}

/** A setting in the config at `home`, if the config reads as a map. */
export function configSetting(home: string, key: string): unknown {
  const parsed = parseYamlFile(configPath(home));
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return undefined;
  return key in parsed.value ? Reflect.get(parsed.value, key) : undefined;
}

/** Whether the config at `home` links `key` to `home/<file>`, so the default belongs there. */
export function usesHomeFile(home: string, key: string, file: string): boolean {
  const value = configSetting(home, key);
  return typeof value === "string" && resolveConfigPath(home, value) === join(home, file);
}
