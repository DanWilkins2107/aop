import { exportsOf, importedFile, importsOf, isTest, withoutComments, within } from "./source.js";

/** A folder of shared code, and the folders that may use it. */
export interface SharedUse {
  shared: string;
  users: string[];
}

/**
 * The exports of the shared folder that aren't shared. An export belongs there when two or more of
 * the user folders import it, or when one does and other shared code is built from it. Tests don't
 * count as users. Also the imports the gate can't count, because they don't name what they take.
 */
export function sharedUseProblems(sources: Record<string, string>, { shared, users }: SharedUse): string[] {
  const problems: string[] = [];
  const usersOf = new Map<string, Set<string>>();
  for (const [file, text] of Object.entries(sources)) {
    const user = users.find((folder) => within(file, folder));
    if (user === undefined || isTest(file)) continue;
    for (const { specifier, names } of importsOf(text)) {
      const target = importedFile(file, specifier);
      if (target === null || !within(target, shared)) continue;
      if (names === null) problems.push(`${file}: imports ${specifier} without naming what it takes: import from ${shared} by name`);
      for (const name of names ?? []) {
        const key = `${target}#${name}`;
        usersOf.set(key, (usersOf.get(key) ?? new Set()).add(user));
      }
    }
  }

  const sharedFiles = Object.entries(sources).filter(([file]) => within(file, shared) && !isTest(file));
  const sharedCode = sharedFiles.map(([, text]) => withoutComments(text)).join("\n");
  for (const [file, text] of sharedFiles) {
    for (const { name } of exportsOf(text).exports) {
      const by = [...(usersOf.get(`${file}#${name}`) ?? [])].sort();
      const mentions = sharedCode.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
      if (by.length >= 2 || (by.length === 1 && mentions >= 2)) continue;
      problems.push(by.length === 0 ? `${file}: nothing outside ${shared} imports ${name}: stop exporting it` : `${file}: only ${by[0]} imports ${name}: move it there`);
    }
  }
  return problems;
}
