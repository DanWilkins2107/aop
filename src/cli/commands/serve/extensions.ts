// The extensions `config.yaml` registers, read once when `aop serve` builds. Only a human edits that
// list: the settings page refuses a save that changes it, and no tool writes it.

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { configPath, resolveConfigPath } from "../../../server/shared/paths.js";
import { parseYamlFile } from "../../../server/shared/yamlFile.js";

/** Each place an extension can add to, and the file it starts from there. */
export const ENTRIES = { web: "web/index.tsx", server: "server/index.ts", cli: "cli/index.ts", mcp: "mcp/index.ts" } as const;

export type EntryKind = keyof typeof ENTRIES;

export interface Extension {
  /** Its folder's name. */
  name: string;
  /** Its folder, with no links in the path. */
  path: string;
  /** The entries it has, in `ENTRIES` order. */
  entries: EntryKind[];
}

export type ExtensionsResult = { ok: true; extensions: Extension[] } | { ok: false; problems: string[] };

const NAME = /^[a-z][a-z0-9-]*$/;
/** Never copied into a build. */
export const SKIPPED = new Set([".git", "node_modules"]);

/** The first link under `dir`, skipping `SKIPPED`, or null if it has none. */
export function linkIn(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) return path;
    const inner = entry.isDirectory() ? linkIn(path) : null;
    if (inner !== null) return inner;
  }
  return null;
}

function readOne(home: string, setting: unknown, index: number, problems: string[]): Extension | null {
  const key = `extensions[${index}]`;
  if (typeof setting !== "string" || setting.trim().length === 0) {
    problems.push(`${key}: must be the path of an extension's folder`);
    return null;
  }
  const given = resolveConfigPath(home, setting.trim());
  if (!existsSync(given) || !statSync(given).isDirectory()) {
    problems.push(`${key}: ${given} isn't a folder`);
    return null;
  }
  const path = realpathSync(given);
  const name = basename(path);
  if (!NAME.test(name)) {
    problems.push(`${key}: ${path}: the folder's name, "${name}", must be lowercase letters, digits and dashes, starting with a letter`);
    return null;
  }
  const link = linkIn(path);
  if (link !== null) {
    problems.push(`${key}: ${link} is a link, which an extension can't have`);
    return null;
  }
  const entries = (Object.keys(ENTRIES) as EntryKind[]).filter((kind) => existsSync(join(path, ENTRIES[kind])));
  if (entries.length === 0) {
    problems.push(`${key}: ${path} has none of ${Object.values(ENTRIES).join(", ")}`);
    return null;
  }
  return { name, path, entries };
}

/** The extensions `config.yaml` in `home` lists, in its order, checked. No config, or no list, is none. */
export function readExtensions(home: string): ExtensionsResult {
  const file = configPath(home);
  if (!existsSync(file)) return { ok: true, extensions: [] };
  const parsed = parseYamlFile(file);
  // Serving reports a broken config itself.
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return { ok: true, extensions: [] };
  const listed: unknown = Reflect.get(parsed.value, "extensions");
  if (listed === undefined || listed === null) return { ok: true, extensions: [] };
  if (!Array.isArray(listed)) return { ok: false, problems: [`${file}: extensions: must be a list of folders`] };

  const problems: string[] = [];
  const extensions: Extension[] = [];
  listed.forEach((setting: unknown, index) => {
    const extension = readOne(home, setting, index, problems);
    if (extension === null) return;
    const twin = extensions.find((other) => other.name === extension.name);
    if (twin === undefined) extensions.push(extension);
    else problems.push(`extensions[${index}]: ${extension.path} has the same name as ${twin.path}`);
  });
  return problems.length > 0 ? { ok: false, problems: problems.map((p) => (p.startsWith(file) ? p : `${file}: ${p}`)) } : { ok: true, extensions };
}
