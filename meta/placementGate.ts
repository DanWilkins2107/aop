/** What a file's path below a folder must match, by that folder. Files outside every folder aren't checked. */
export type Layout = Record<string, RegExp>;

const TEST = /\.test\.ts$/;

/** The files that sit where their folder's layout doesn't allow, and the tests that aren't beside what they test. */
export function placementProblems(files: string[], layout: Layout): string[] {
  const all = new Set(files);
  const problems: string[] = [];
  for (const file of files) {
    const root = Object.keys(layout).find((folder) => file.startsWith(`${folder}/`));
    if (root === undefined) continue;
    const allowed = layout[root]!;
    if (!allowed.test(file.slice(root.length + 1))) {
      problems.push(`${file}: not where ${root}'s layout allows (${allowed.source})`);
    } else if (TEST.test(file) && !all.has(file.replace(TEST, ".ts"))) {
      problems.push(`${file}: tests no file beside it`);
    }
  }
  return problems;
}
