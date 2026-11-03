import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { StagesView, Turn } from "../shared/api.js";
import { parseYamlFile } from "./yamlFile.js";

export const BUILT_IN_STAGES = [
  "done",
  "broken_down",
  "invalidated",
  "scheduled",
  "ask_human_question",
  "failed",
] as const;

export type BuiltInStage = (typeof BUILT_IN_STAGES)[number];

export function isBuiltIn(name: string): name is BuiltInStage {
  return (BUILT_IN_STAGES as readonly string[]).includes(name);
}

export type { Turn };

export interface StageDef {
  turn: Turn;
  color?: string;
  /** Absolute path. Present on agent stages. */
  prompt?: string;
}

export interface TypeDef {
  start: string;
  /** Stage name to its outcomes (outcome name to target). */
  stages: Map<string, Map<string, string>>;
}

/** A validated `stages.yaml`. Maps, so that names like "constructor" can't hit Object.prototype. */
export interface StageGraph {
  stages: Map<string, StageDef>;
  types: Map<string, TypeDef>;
}

const fileSchema = z.strictObject({
  stages: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.unknown()),
});

const stageSchema = z.strictObject({
  turn: z.enum(["agent", "human"]),
  prompt: z.string().min(1).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a hex colour such as "#5c7cfa"')
    .optional(),
});

const typeSchema = z.strictObject({
  start: z.string().min(1),
  stages: z.record(z.string(), z.unknown()),
});

const typeStageSchema = z.strictObject({
  next: z.record(z.string().min(1), z.string().min(1)),
});

function zodProblems(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `${prefix}${path ? `.${path}` : ""}: ${issue.message}`;
  });
}

/**
 * Validates a parsed `stages.yaml`. Each stage and type is checked on its own so that one
 * malformed entry doesn't hide problems elsewhere: the result has every problem found.
 */
export function validateStages(
  raw: unknown,
  baseDir: string,
): { graph: StageGraph; problems: string[] } {
  const problems: string[] = [];
  const graph: StageGraph = { stages: new Map(), types: new Map() };

  const file = fileSchema.safeParse(raw);
  if (!file.success) {
    return { graph, problems: zodProblems("stages.yaml", file.error) };
  }
  const poolNames = new Set(Object.keys(file.data.stages));
  const typeNames = new Set(Object.keys(file.data.types));

  for (const [name, rawStage] of Object.entries(file.data.stages)) {
    const label = `stage "${name}"`;
    if (isBuiltIn(name)) problems.push(`${label}: "${name}" is a reserved built-in stage name`);
    if (typeNames.has(name)) problems.push(`${label}: a type has the same name`);

    const stage = stageSchema.safeParse(rawStage);
    if (!stage.success) {
      problems.push(...zodProblems(label, stage.error));
      continue;
    }
    const def: StageDef = { turn: stage.data.turn };
    if (stage.data.color !== undefined) def.color = stage.data.color;
    if (stage.data.turn === "agent") {
      if (stage.data.prompt === undefined) {
        problems.push(`${label}: agent stage has no prompt`);
      } else {
        const promptPath = resolve(baseDir, stage.data.prompt);
        if (!existsSync(promptPath) || !statSync(promptPath).isFile()) {
          problems.push(`${label}: prompt file not found: ${promptPath}`);
        }
        def.prompt = promptPath;
      }
    }
    graph.stages.set(name, def);
  }

  for (const [name, rawType] of Object.entries(file.data.types)) {
    const label = `type "${name}"`;
    if (isBuiltIn(name)) problems.push(`${label}: "${name}" is a reserved built-in stage name`);

    const type = typeSchema.safeParse(rawType);
    if (!type.success) {
      problems.push(...zodProblems(label, type.error));
      continue;
    }
    const memberNames = new Set(Object.keys(type.data.stages));
    const def: TypeDef = { start: type.data.start, stages: new Map() };

    if (!memberNames.has(type.data.start)) {
      problems.push(`${label}: start "${type.data.start}" is not one of the type's stages`);
    }

    for (const [stageName, rawTypeStage] of Object.entries(type.data.stages)) {
      const stageLabel = `${label}, stage "${stageName}"`;
      // `scheduled` is the one built-in with outcomes, so it's the only one a type can list.
      if (!poolNames.has(stageName) && stageName !== "scheduled") {
        problems.push(`${stageLabel}: not in the stage pool`);
      }
      const typeStage = typeStageSchema.safeParse(rawTypeStage);
      if (!typeStage.success) {
        problems.push(...zodProblems(stageLabel, typeStage.error));
        continue;
      }
      const next = new Map(Object.entries(typeStage.data.next));
      for (const [outcome, target] of next) {
        const resolves =
          memberNames.has(target) ||
          typeNames.has(target) ||
          // `scheduled` must be listed in the type, which says where its children start.
          (isBuiltIn(target) && target !== "scheduled");
        if (!resolves) {
          problems.push(
            `${stageLabel}: outcome "${outcome}" targets "${target}", which is not a stage in this type, a type, or a built-in`,
          );
        }
      }
      if (stageName === "scheduled" && next.size !== 1) {
        problems.push(`${stageLabel}: must have exactly one outcome, saying where children start`);
      }
      def.stages.set(stageName, next);
    }
    graph.types.set(name, def);
  }

  return { graph, problems };
}

/** What the UI needs to draw a process. Leaves out prompt paths, which are the server's business. */
export function describeStages(graph: StageGraph): StagesView {
  return {
    stages: [...graph.stages].map(([name, def]) => ({ name, turn: def.turn, color: def.color ?? null })),
    types: [...graph.types].map(([name, def]) => ({
      name,
      start: def.start,
      stages: [...def.stages].map(([stage, next]) => ({
        name: stage,
        next: [...next].map(([outcome, target]) => ({ outcome, target })),
      })),
    })),
  };
}

/** Returns the parsed file and every problem in it. Never throws for bad content. */
export function loadStagesFile(path: string): { graph: StageGraph; problems: string[] } {
  const parsed = parseYamlFile(path);
  if (!parsed.ok) {
    return { graph: { stages: new Map(), types: new Map() }, problems: parsed.problems };
  }
  return validateStages(parsed.value, dirname(path));
}
