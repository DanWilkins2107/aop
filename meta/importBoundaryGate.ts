import path from "node:path";

/** What the code in one folder may reach. Its tests aren't checked. */
export interface Boundary {
  /** The other folders it may import from, besides itself. */
  folders: string[];
  /** The packages it may import. Left out, any package will do. */
  packages?: string[];
  /** The browser loads it, so it can't use Node's modules or globals. */
  browser?: boolean;
}

/** Boundaries by folder. Files outside every folder aren't checked. */
export type Boundaries = Record<string, Boundary>;

const TEST = /\.test\.ts$/;
const IMPORT = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const NODE_GLOBAL = /\b(?:process|Buffer)(?=\.\w)|\b__(?:dir|file)name\b|\brequire(?=\()|\bimport\.meta\.(?:dirname|filename)\b/;

/** The imports that leave a folder's boundary, and the uses of Node in code the browser loads. */
export function importBoundaryProblems(sources: Record<string, string>, boundaries: Boundaries): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const root = Object.keys(boundaries).find((folder) => within(file, folder));
    if (root === undefined || TEST.test(file)) continue;
    const boundary = boundaries[root]!;
    for (const [, specifier] of text.matchAll(IMPORT)) {
      const problem = importProblem(file, specifier!, root, boundary);
      if (problem !== null) problems.push(`${file}: imports ${specifier}, ${problem}`);
    }
    const used = boundary.browser ? NODE_GLOBAL.exec(text) : null;
    if (used !== null) problems.push(`${file}: uses ${used[0]}, which needs Node, and the browser loads ${root}`);
  }
  return problems;
}

function importProblem(file: string, specifier: string, root: string, boundary: Boundary): string | null {
  if (specifier.startsWith(".")) {
    const target = path.posix.join(path.posix.dirname(file), specifier);
    return [root, ...boundary.folders].some((folder) => within(target, folder)) ? null : `which is outside ${root}`;
  }
  if (specifier.startsWith("node:")) return boundary.browser ? `which needs Node, and the browser loads ${root}` : null;
  const name = specifier.split("/", specifier.startsWith("@") ? 2 : 1).join("/");
  return boundary.packages === undefined || boundary.packages.includes(name) ? null : `a package ${root} may not use`;
}

const within = (file: string, folder: string) => file.startsWith(`${folder}/`);
