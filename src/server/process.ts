// The process page's view of `stages.yaml`, which still answers while the config is invalid. Not to be
// confused with `processes.ts`, which is about operating system processes.

import { existsSync } from "node:fs";
import type { ProcessView } from "../shared/api.js";
import { loadConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { aopHome, configPath, resolveConfigPath } from "./paths.js";
import { describeStages, loadStagesFile } from "./stages.js";
import { parseYamlFile } from "./yamlFile.js";

/** Where `config.yaml` says `stages.yaml` is, read without needing the rest of the config to be valid. */
function stagesPathFrom(home: string): string | null {
  const parsed = parseYamlFile(configPath(home));
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return null;
  const setting = (parsed.value as Record<string, unknown>)["stages"];
  return typeof setting === "string" && setting.length > 0 ? resolveConfigPath(home, setting) : null;
}

/**
 * What the process page draws. Unlike `/api/stages`, an invalid config is a normal answer here: the
 * page lists the problems and draws whatever of `stages.yaml` could be read.
 */
export function describeProcess(home: string = aopHome()): ProcessView {
  try {
    const config = loadConfig(home);
    return { stages_path: config.stagesPath, problems: [], process: describeStages(config.graph) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const stagesPath = stagesPathFrom(home);
    const graph = stagesPath !== null && existsSync(stagesPath) ? loadStagesFile(stagesPath).graph : null;
    return {
      stages_path: stagesPath,
      problems: error.problems,
      process: graph !== null && graph.types.size > 0 ? describeStages(graph) : null,
    };
  }
}
