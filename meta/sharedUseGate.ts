import { exportsOf, importedFile, importsOf, isTest, withoutComments, within } from "./source.js";

/** A folder of shared code, and the folders that may use it. */
export interface SharedUse {
  shared: string;
  users: string[];
  /** Count each importing file as a user, not each folder: for a folder's own `shared/`. */
  byFile?: boolean;
}

/**
 * The exports of the shared folder that aren't shared. An export belongs there when two or more of
 * the user folders (or files, `byFile`) import it, or when one does and other shared code is built
 * from it. Tests, and the shared folder itself, don't count as users. Also the imports the gate
 * can't count, because they don't name what they take.
 */
export function sharedUseProblems(sources: Record<string, string>, use: SharedUse): string[] {
  const { shared } = use;
  const problems: string[] = [];
  const usersOf = new Map<string, Set<string>>();
  for (const [file, text] of Object.entries(sources)) {
    const user = userOf(file, use);
    if (user === null) continue;
    for (const { specifier, names, target } of sharedImports(file, text, shared)) {
      if (names === null) problems.push(`${file}: imports ${specifier} without naming what it takes: import from ${shared} by name`);
      for (const name of names ?? []) {
        const key = `${target}#${name}`;
        usersOf.set(key, (usersOf.get(key) ?? new Set()).add(user));
      }
    }
  }
  return [...problems, ...unsharedExports(sources, shared, usersOf)];
}

/** Who `file` counts as when it imports shared code: its folder, or itself with `byFile`. Null if it doesn't count. */
function userOf(file: string, { shared, users, byFile = false }: SharedUse): string | null {
  const folder = users.find((user) => within(file, user));
  if (folder === undefined || isTest(file) || within(file, shared)) return null;
  return byFile ? file : folder;
}

/** The imports in `file` that reach the shared folder, with the file each one reaches. */
function sharedImports(file: string, text: string, shared: string) {
  return importsOf(text)
    .map((found) => ({ ...found, target: importedFile(file, found.specifier) }))
    .filter(({ target }) => target !== null && within(target, shared));
}

/** The shared exports that fewer than two users import, unless other shared code uses them too. */
function unsharedExports(sources: Record<string, string>, shared: string, usersOf: Map<string, Set<string>>): string[] {
  const problems: string[] = [];
  const sharedFiles = Object.entries(sources).filter(([file]) => within(file, shared) && !isTest(file));
  const sharedCode = sharedFiles.map(([, text]) => withoutComments(text)).join("\n");
  for (const [file, text] of sharedFiles) {
    for (const { name } of exportsOf(text).exports) {
      const by = [...(usersOf.get(`${file}#${name}`) ?? [])].toSorted();
      const mentions = sharedCode.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
      if (by.length >= 2 || (by.length === 1 && mentions >= 2)) continue;
      problems.push(by.length === 0 ? `${file}: nothing outside ${shared} imports ${name}: stop exporting it` : `${file}: only ${by[0]} imports ${name}: move it there`);
    }
  }
  return problems;
}
