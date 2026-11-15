import path from "node:path";
import { importedFile, importsOf, isTest, within } from "./source.js";

const HELPERS = /\.helpers\.tsx?$/;

/** The test helpers under `folders` that tests in two or more folders import, but that aren't in a `test-shared` folder. */
export function helperPlacementProblems(sources: Record<string, string>, folders: string[]): string[] {
  const usersOf = new Map<string, Set<string>>();
  for (const [file, text] of Object.entries(sources)) {
    if (!isTest(file)) continue;
    for (const { specifier } of importsOf(text)) {
      const target = importedFile(file, specifier);
      if (target === null || !isLooseHelper(target, folders)) continue;
      usersOf.set(target, (usersOf.get(target) ?? new Set()).add(path.posix.dirname(file)));
    }
  }
  return [...usersOf]
    .filter(([, users]) => users.size >= 2)
    .map(([helper, users]) => `${helper}: tests in ${[...users].toSorted().join(", ")} use it: move it to a test-shared folder`);
}

const isLooseHelper = (file: string, folders: string[]): boolean =>
  HELPERS.test(file) && !file.split("/").includes("test-shared") && folders.some((folder) => within(file, folder));
