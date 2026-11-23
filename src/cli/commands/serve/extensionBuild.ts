// Compiles the registered extensions into `dist/extensions`, from a copy taken now, so later edits to
// an extension's folder can't reach a running AOP. Type errors fail the build. What went in is
// recorded in `dist/extensions/extension-build.json`.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { noCwdLookupEnv } from "../../../shared/os/noCwdLookupEnv.js";
import { ENTRIES, type EntryKind, type Extension, SKIPPED } from "./extensions.js";

const NODE_ENTRIES: EntryKind[] = ["server", "cli", "mcp"];

const NODE_OPTIONS = { target: "ES2023", lib: ["ES2023"], module: "NodeNext", moduleResolution: "NodeNext", types: ["node"] };
const WEB_OPTIONS = {
  target: "ES2022",
  lib: ["ES2023", "DOM", "DOM.Iterable"],
  module: "ESNext",
  moduleResolution: "Bundler",
  jsx: "react-jsx",
  types: [],
};

interface Built {
  name: string;
  path: string;
  /** The git commit it was built from, or null outside a git repo. */
  commit: string | null;
  /** Whether it had changes not in that commit. */
  dirty: boolean;
  /** Each entry's compiled file, under its folder in `dist/extensions`. */
  entries: Partial<Record<EntryKind, string>>;
  /** Every file copied in, relative to the extension. */
  files: string[];
}

/** Where the build goes, under the checkout. */
export const extensionsDir = (root: string): string => join(root, "dist", "extensions");

/** Every file under `dir`, relative to it, with `/` separators. */
function filesIn(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path, base) : [relative(base, path).split("\\").join("/")];
  });
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...noCwdLookupEnv } });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Copies the extension, minus `SKIPPED` and package.json files, which could make its code CommonJS. */
function copy(extension: Extension, to: string): void {
  cpSync(extension.path, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !SKIPPED.has(basename(source)) && basename(source) !== "package.json",
  });
}

/** Type-checks and emits one group of entries, returning tsc's report if it failed. */
function compile(root: string, name: string, side: "node" | "web", kinds: EntryKind[]): string | null {
  if (kinds.length === 0) return null;
  const sources = join(extensionsDir(root), ".src");
  const tsconfig = join(sources, `${name}.${side}.json`);
  const compilerOptions = {
    ...(side === "node" ? NODE_OPTIONS : WEB_OPTIONS),
    strict: true,
    skipLibCheck: true,
    noEmitOnError: true,
    rootDir: `./${name}`,
    outDir: `../${name}`,
  };
  const files = kinds.map((kind) => `./${name}/${ENTRIES[kind]}`);
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions, files }, null, 2));
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", tsconfig], { cwd: sources, encoding: "utf8" });
  if (result.status === 0) return null;
  return `${result.stdout}${result.stderr}`.trim() || `tsc exited with ${result.status ?? result.signal}`;
}

function buildOne(root: string, extension: Extension): Built | string {
  const { name } = extension;
  const staged = join(extensionsDir(root), ".src", name);
  copy(extension, staged);
  const node = NODE_ENTRIES.filter((kind) => extension.entries.includes(kind));
  const web = extension.entries.includes("web") ? (["web"] as EntryKind[]) : [];
  for (const [side, kinds] of [["node", node], ["web", web]] as const) {
    const failed = compile(root, name, side, kinds);
    if (failed !== null) return `Extension "${name}" (${extension.path}) didn't compile:\n${failed}`;
  }
  const entries = Object.fromEntries(extension.entries.map((kind) => [kind, ENTRIES[kind].replace(/\.tsx?$/, ".js")]));
  const commit = git(extension.path, ["rev-parse", "HEAD"]);
  const dirty = commit !== null && (git(extension.path, ["status", "--porcelain"]) ?? "") !== "";
  return { name, path: extension.path, commit, dirty, entries, files: filesIn(staged) };
}

/**
 * Builds `extensions` into the checkout at `root`, replacing any earlier build, so a removed
 * extension's code goes too. Logs each file it compiles in. Returns the problems, empty if it built.
 */
export function buildExtensions(root: string, extensions: Extension[], log: (line: string) => void): string[] {
  const out = extensionsDir(root);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, ".src"), { recursive: true });
  // Their compiled code is ES modules, whatever the extension's own package.json says.
  writeFileSync(join(out, "package.json"), `${JSON.stringify({ type: "module" })}\n`);

  const built: Built[] = [];
  let problem: string | null = null;
  for (const extension of extensions) {
    const result = buildOne(root, extension);
    if (typeof result === "string") {
      problem = result;
      break;
    }
    log(`Built extension "${result.name}" from ${result.path}: ${result.files.join(", ")}`);
    built.push(result);
  }
  const record = { built_at: new Date().toISOString(), extensions: built, problems: problem === null ? [] : [problem] };
  writeFileSync(join(out, "extension-build.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record.problems;
}
