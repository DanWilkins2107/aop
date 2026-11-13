import { exportsOf, isTest, within } from "./source.js";

const TYPES_FILE = "types.ts";
const sameName = (file: string, name: string) => plain(file.replace(/\.ts$/, "")) === plain(name);
const plain = (name: string) => name.replace(/_/g, "").toLowerCase();

/**
 * The files in `folders` that don't keep to one export each: a folder's types all go in its
 * `types.ts`, and every other file exports one value, named as the file is. Tests aren't checked.
 */
export function exportShapeProblems(sources: Record<string, string>, folders: string[]): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (isTest(file) || !folders.some((folder) => within(file, folder))) continue;
    const base = file.slice(file.lastIndexOf("/") + 1);
    const { exports, unreadable } = exportsOf(text);
    for (const line of unreadable) problems.push(`${file}: \`${line}\` isn't a declaration: export each thing where it's declared`);
    if (base === TYPES_FILE) {
      for (const { name, isType } of exports) if (!isType) problems.push(`${file}: exports ${name}, which isn't a type: give it a file of its own`);
      continue;
    }
    for (const { name, isType } of exports) if (isType) problems.push(`${file}: exports the type ${name}: types go in the folder's ${TYPES_FILE}`);
    const values = exports.filter(({ isType }) => !isType);
    if (values.length !== 1) problems.push(`${file}: exports ${values.length} values (${values.map(({ name }) => name).join(", ")}): one per file`);
    else if (!sameName(base, values[0]!.name)) problems.push(`${file}: exports ${values[0]!.name}: name the file after its export`);
  }
  return problems;
}
