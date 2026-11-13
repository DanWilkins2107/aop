import path from "node:path";

/** One `import`, or `export ... from`, in a file. */
export interface Import {
  specifier: string;
  /** The names it takes, before any `as`. Null when it takes the module some other way: whole, by default, for its effects, or to re-export. */
  names: string[] | null;
}

/** One `export` declared in a file. */
export interface Export {
  name: string;
  isType: boolean;
}

const FROM = /^[ \t]*(import|export)\s+(?:type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/gm;
const BARE = /\bimport\s*\(?\s*["']([^"']+)["']/g;
const EXPORT = /^export\s+(.*)$/gm;
const DECLARATION = /^(?:declare\s+)?(?:(type|interface)|(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum))\s+(\w+)/;

/** Every import in a file's text, read with regular expressions, so a commented-out import counts too. */
export function importsOf(text: string): Import[] {
  const found: Import[] = [];
  for (const [, keyword, clause, specifier] of text.matchAll(FROM)) {
    const named = keyword === "import" ? /^\{([^}]*)\}$/.exec(clause!) : null;
    found.push({ specifier: specifier!, names: named === null ? null : namesIn(named[1]!) });
  }
  for (const [, specifier] of text.matchAll(BARE)) found.push({ specifier: specifier!, names: null });
  return found;
}

const namesIn = (list: string): string[] =>
  list
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!)
    .filter((name) => name !== "");

/** A file's exports, and the `export` lines that aren't a declaration: defaults, lists and re-exports. */
export function exportsOf(text: string): { exports: Export[]; unreadable: string[] } {
  const exports: Export[] = [];
  const unreadable: string[] = [];
  for (const [line, rest] of text.matchAll(EXPORT)) {
    const declared = DECLARATION.exec(rest!);
    if (declared === null) unreadable.push(line.trim());
    else exports.push({ name: declared[2]!, isType: declared[1] !== undefined });
  }
  return { exports, unreadable };
}

/** The repo path a relative import points at, as the `.ts` file it's written in. Null for a package. */
export function importedFile(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return path.posix.join(path.posix.dirname(from), specifier).replace(/\.js$/, ".ts");
}

/** Whether a file is a test, or something only tests use. */
export function isTest(file: string): boolean {
  return /\.(test|helpers)\.tsx?$/.test(file) || /(^|\/)(test|test-shared)\//.test(file);
}

/** A file's code without its comments, for looking names up in. */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export const within = (file: string, folder: string): boolean => file.startsWith(`${folder}/`);
