// Parses and validates `stages.yaml` into a `StageGraph`. The built-in stages are named in
// `src/shared/stages/`.

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Turn } from "../../shared/nodes/types.js";
import type { StagesView, TypeView } from "../../shared/stages/types.js";
import { FINISHED_STAGES } from "../../shared/stages/finishedStages.js";
import { isBuiltIn } from "../../shared/stages/isBuiltIn.js";
import { parseYaml, parseYamlFile } from "../shared/yamlFile.js";


interface StageDef {
  turn: Turn;
  color?: string;
  /** Absolute path. Present on agent stages. */
  prompt?: string;
}

/** How a parallel group turns its branches' results into one outcome. */
export type Gate = "all_pass";

interface ParallelGroup {
  /** Agent stages from the pool, or types run as sub-workflows. */
  branches: string[];
  /** Null: the group ends with `done` once every branch has finished. */
  gate: Gate | null;
}

interface TypeDef {
  start: string;
  /** Stage name to its outcomes (outcome name to target). */
  stages: Map<string, Map<string, string>>;
  /** Stages that run a type as a sub-workflow: stage name to that type. */
  subflows: Map<string, string>;
  /** Stages that run their branches at once. */
  parallel: Map<string, ParallelGroup>;
  /** Stages a loop re-enters: stage name to how many times it may be entered. */
  maxLoops: Map<string, number>;
  /** Whether a `subflow:` stage or a parallel branch runs this type. Such a type has only agent stages. */
  isSubflow: boolean;
}

/** The outcomes a parallel group can end with. */
export function groupOutcomes(gate: Gate | null): string[] {
  return gate === "all_pass" ? ["pass", "fail"] : ["done"];
}

/** The outcomes a sub-workflow can end with: `done`, and `exhausted` once a `max_loops` runs out. */
function subflowExits(type: TypeDef): string[] {
  return type.maxLoops.size > 0 ? ["done", "exhausted"] : ["done"];
}

/** What a stage of a type does when entered. */
type Step =
  | { kind: "agent" }
  | { kind: "subflow"; type: string }
  | { kind: "parallel"; branches: string[]; gate: "all_pass" | null };

export function stepOf(graph: StageGraph, type: string, stage: string): Step {
  const def = graph.types.get(type);
  const subflow = def?.subflows.get(stage);
  if (subflow !== undefined) return { kind: "subflow", type: subflow };
  const group = def?.parallel.get(stage);
  if (group !== undefined) return { kind: "parallel", branches: group.branches, gate: group.gate };
  return { kind: "agent" };
}

/** Whether a node on this stage runs branches rather than an agent of its own. */
export function runsBranches(graph: StageGraph, type: string, stage: string): boolean {
  return stepOf(graph, type, stage).kind !== "agent";
}

/** A validated `stages.yaml`. Maps, so that names like "constructor" can't hit Object.prototype. */
export interface StageGraph {
  /** The type new nodes enter. Empty only when validation reported that it's missing. */
  start: string;
  stages: Map<string, StageDef>;
  types: Map<string, TypeDef>;
}

const fileSchema = z.strictObject({
  // Optional here so that leaving it out doesn't hide every other problem. Checked below.
  start: z.string().min(1).optional(),
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
  subflow: z.string().min(1).optional(),
  parallel: z.array(z.string().min(1)).min(1).optional(),
  gate: z.enum(["all_pass"]).optional(),
  max_loops: z.number().int().positive().optional(),
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
function validateStages(
  raw: unknown,
  baseDir: string,
  /** How problems name the file, such as `improvement_stages.yaml`. */
  fileLabel = "stages.yaml",
): { graph: StageGraph; problems: string[] } {
  const problems: string[] = [];
  const graph: StageGraph = { start: "", stages: new Map(), types: new Map() };

  const file = fileSchema.safeParse(raw);
  if (!file.success) {
    return { graph, problems: zodProblems(fileLabel, file.error) };
  }
  const poolNames = new Set(Object.keys(file.data.stages));
  const typeNames = new Set(Object.keys(file.data.types));

  if (file.data.start === undefined) {
    problems.push(`${fileLabel}: the top-level "start" is missing`);
  } else {
    graph.start = file.data.start;
    if (!typeNames.has(file.data.start)) problems.push(`${fileLabel}: start "${file.data.start}" is not a type`);
  }

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
        } else if (!isInside(baseDir, promptPath)) {
          // A prompt goes straight to an agent, so a shared process file mustn't be able to point
          // it at the user's own files, such as keys or credentials.
          problems.push(`${label}: prompt must be in the stages file's folder: ${stage.data.prompt}`);
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
    const def: TypeDef = {
      start: type.data.start,
      stages: new Map(),
      subflows: new Map(),
      parallel: new Map(),
      maxLoops: new Map(),
      isSubflow: false,
    };

    if (!memberNames.has(type.data.start)) {
      problems.push(`${label}: start "${type.data.start}" is not one of the type's stages`);
    }

    for (const [stageName, rawTypeStage] of Object.entries(type.data.stages)) {
      const stageLabel = `${label}, stage "${stageName}"`;
      const typeStage = typeStageSchema.safeParse(rawTypeStage);
      if (!typeStage.success) {
        if (!poolNames.has(stageName) && stageName !== "scheduled") problems.push(`${stageLabel}: not in the stage pool`);
        problems.push(...zodProblems(stageLabel, typeStage.error));
        continue;
      }
      const { subflow, parallel, gate, max_loops: maxLoops } = typeStage.data;
      const next = new Map(Object.entries(typeStage.data.next));
      if (subflow !== undefined || parallel !== undefined) {
        // A step of the type's own, so it mustn't be mistaken for a pool stage or a type.
        if (isBuiltIn(stageName)) problems.push(`${stageLabel}: "${stageName}" is a reserved built-in stage name`);
        if (poolNames.has(stageName)) problems.push(`${stageLabel}: a stage in the pool has the same name`);
        if (typeNames.has(stageName)) problems.push(`${stageLabel}: a type has the same name`);
      } else if (!poolNames.has(stageName) && stageName !== "scheduled") {
        // `scheduled` is the one built-in with outcomes, so it's the only one a type can list.
        problems.push(`${stageLabel}: not in the stage pool`);
      }
      if (subflow !== undefined && parallel !== undefined) {
        problems.push(`${stageLabel}: can't have both subflow and parallel`);
      }
      if (gate !== undefined && parallel === undefined) problems.push(`${stageLabel}: gate needs parallel`);
      if (subflow !== undefined) {
        if (typeNames.has(subflow)) def.subflows.set(stageName, subflow);
        else problems.push(`${stageLabel}: subflow "${subflow}" is not a type`);
      }
      if (parallel !== undefined && subflow === undefined) {
        const group: ParallelGroup = { branches: [], gate: gate ?? null };
        for (const branch of parallel) {
          if (group.branches.includes(branch)) {
            problems.push(`${stageLabel}: branch "${branch}" is listed twice`);
          } else if (typeNames.has(branch) || graph.stages.get(branch)?.turn === "agent") {
            group.branches.push(branch);
          } else if (graph.stages.has(branch)) {
            problems.push(`${stageLabel}: branch "${branch}" is not an agent stage`);
          } else if (!poolNames.has(branch)) {
            // A pool stage that failed to parse has already been reported.
            problems.push(`${stageLabel}: branch "${branch}" is not a stage in the pool or a type`);
          }
        }
        const outcomes = groupOutcomes(group.gate);
        problems.push(...outcomeProblems(stageLabel, next, outcomes, "this group"));
        def.parallel.set(stageName, group);
      }
      if (maxLoops !== undefined) def.maxLoops.set(stageName, maxLoops);
      for (const [outcome, target] of next) {
        if (isBuiltIn(target)) {
          if (!FINISHED_STAGES.includes(target)) {
            problems.push(
              `${stageLabel}: outcome "${outcome}" targets "${target}", but done and broken_down are the only built-ins next can target`,
            );
          }
        } else if (!memberNames.has(target) && !typeNames.has(target)) {
          problems.push(
            `${stageLabel}: outcome "${outcome}" targets "${target}", which is not a stage in this type, a type, done or broken_down`,
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

  problems.push(...subflowProblems(graph));
  return { graph, problems };
}

/** Problems with a step whose outcomes are fixed: `next` must map each of them, and nothing else. */
function outcomeProblems(stageLabel: string, next: Map<string, string>, outcomes: string[], what: string): string[] {
  const problems: string[] = [];
  for (const outcome of outcomes) {
    if (!next.has(outcome)) problems.push(`${stageLabel}: next must map "${outcome}", which ${what} can end with`);
  }
  for (const outcome of next.keys()) {
    if (!outcomes.includes(outcome)) {
      problems.push(`${stageLabel}: "${outcome}" is not an outcome of ${what}, which ends with ${outcomes.join(" or ")}`);
    }
  }
  return problems;
}

/** The types a type runs: through `subflow:` stages and parallel branches. */
function typesRunBy(graph: StageGraph, type: TypeDef): string[] {
  const run = [...type.subflows.values()];
  for (const group of type.parallel.values()) run.push(...group.branches.filter((branch) => graph.types.has(branch)));
  return run;
}

/** Checks the types run inside a node, once every type is parsed, and marks them `isSubflow`. */
function subflowProblems(graph: StageGraph): string[] {
  const problems: string[] = [];
  for (const type of graph.types.values()) {
    for (const run of typesRunBy(graph, type)) graph.types.get(run)!.isSubflow = true;
  }

  for (const [name, type] of graph.types) {
    const label = `type "${name}"`;
    for (const [stageName, run] of type.subflows) {
      const exits = subflowExits(graph.types.get(run)!);
      problems.push(...outcomeProblems(`${label}, stage "${stageName}"`, type.stages.get(stageName)!, exits, `subflow "${run}"`));
    }

    if (!type.isSubflow) {
      for (const stageName of type.maxLoops.keys()) {
        problems.push(`${label}, stage "${stageName}": max_loops only works in a type run as a sub-workflow`);
      }
      continue;
    }

    // Nodes never enter a sub-workflow's type: it only runs inside another stage.
    if (graph.start === name) problems.push(`${label}: runs as a sub-workflow, so it can't be the top-level start`);
    for (const [otherName, other] of graph.types) {
      for (const [stageName, next] of other.stages) {
        for (const [outcome, target] of next) {
          if (target === name && !other.stages.has(target)) {
            problems.push(
              `type "${otherName}", stage "${stageName}": outcome "${outcome}" targets "${name}", which runs as a sub-workflow, so nodes can't enter it`,
            );
          }
        }
      }
    }

    let finishes = false;
    for (const [stageName, next] of type.stages) {
      const stageLabel = `${label}, stage "${stageName}"`;
      const ownStep = type.subflows.has(stageName) || type.parallel.has(stageName);
      if (!ownStep && graph.stages.get(stageName)?.turn !== "agent") {
        problems.push(`${stageLabel}: a sub-workflow can only have agent stages`);
      }
      for (const [outcome, target] of next) {
        if (target === "done") finishes = true;
        else if (!type.stages.has(target)) {
          problems.push(`${stageLabel}: outcome "${outcome}" targets "${target}", but a sub-workflow can only target its own stages or done`);
        }
      }
    }
    if (!finishes) problems.push(`${label}: runs as a sub-workflow, so some outcome must target done`);
  }

  // A type that runs itself, however deep, would never finish.
  const reported = new Set<string>();
  for (const name of graph.types.keys()) {
    if (reported.has(name)) continue;
    const cycle = cycleFrom(graph, name);
    if (cycle === null) continue;
    for (const member of cycle) reported.add(member);
    problems.push(`type "${name}": runs itself as a sub-workflow (${[...cycle, name].join(" → ")})`);
  }
  return problems;
}

/** The types from `start` that lead back round to it, or null when it never runs itself. */
function cycleFrom(graph: StageGraph, start: string): string[] | null {
  const seen = new Set<string>();
  const walk = (name: string, path: string[]): string[] | null => {
    for (const run of typesRunBy(graph, graph.types.get(name)!)) {
      if (run === start) return [...path, name];
      if (seen.has(run)) continue;
      seen.add(run);
      const found = walk(run, [...path, name]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(start, []);
}

/** Whether `path` is inside `folder`, once symlinks are followed on both. Both must exist. */
function isInside(folder: string, path: string): boolean {
  const rel = relative(realpathSync.native(folder), realpathSync.native(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** What the UI needs to draw a process. Leaves out prompt paths, which are the server's business. */
export function describeStages(graph: StageGraph): StagesView {
  return {
    start: graph.start,
    stages: [...graph.stages].map(([name, def]) => ({ name, turn: def.turn, color: def.color ?? null })),
    types: [...graph.types].map(([name, def]) => ({
      name,
      start: def.start,
      stages: [...def.stages].map(([stage, next]) => {
        const view: TypeView["stages"][number] = {
          name: stage,
          next: [...next].map(([outcome, target]) => ({ outcome, target })),
        };
        const subflow = def.subflows.get(stage);
        const group = def.parallel.get(stage);
        const maxLoops = def.maxLoops.get(stage);
        if (subflow !== undefined) view.subflow = subflow;
        if (group !== undefined) {
          view.parallel = group.branches;
          if (group.gate !== null) view.gate = group.gate;
        }
        if (maxLoops !== undefined) view.max_loops = maxLoops;
        return view;
      }),
    })),
  };
}

/** Returns the parsed file and every problem in it. Never throws for bad content. */
export function loadStagesFile(path: string, fileLabel?: string): { graph: StageGraph; problems: string[] } {
  const parsed = parseYamlFile(path);
  if (!parsed.ok) {
    return { graph: { start: "", stages: new Map(), types: new Map() }, problems: parsed.problems };
  }
  return validateStages(parsed.value, dirname(path), fileLabel);
}

/** Every problem in `source` as the contents of the process file at `path`, which needn't exist yet. */
export function stagesSourceProblems(source: string, path: string, fileLabel?: string): string[] {
  const parsed = parseYaml(source, path);
  return parsed.ok ? validateStages(parsed.value, dirname(path), fileLabel).problems : parsed.problems;
}

/** A process with nothing in it, for improvements while they're turned off. */
export const EMPTY_GRAPH: StageGraph = { start: "", stages: new Map(), types: new Map() };

/** Every prompt file the graph's agent stages use. */
export function promptFiles(graph: StageGraph): string[] {
  return [...graph.stages.values()].flatMap((stage) => (stage.prompt === undefined ? [] : [stage.prompt]));
}
