import { exportsOf, isTest, within } from "./source.js";

const TYPES_FILE = "types.ts";
const sameName = (file: string, name: string) => plain(file.replace(/\.ts$/, "")) === plain(name);
const plain = (name: string) => name.replaceAll("_", "").toLowerCase();

/**
 * The files in `folders` that don't keep to one export each: a folder's types all go in its
 * `types.ts`, and every other file exports one value, named as the file is. Tests, and the files in
 * `exempt`, aren't checked.
 */
export function exportShapeProblems(sources: Record<string, string>, folders: string[], exempt: string[] = []): string[] {
  return Object.entries(sources)
    .filter(([file]) => !isTest(file) && !exempt.includes(file) && folders.some((folder) => within(file, folder)))
    .flatMap(([file, text]) => fileProblems(file, text));
}

function fileProblems(file: string, text: string): string[] {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const { exports, unreadable } = exportsOf(text);
  const problems = unreadable.map((line) => `${file}: \`${line}\` isn't a declaration: export each thing where it's declared`);
  if (base === TYPES_FILE) {
    for (const { name, isType } of exports) if (!isType) problems.push(`${file}: exports ${name}, which isn't a type: give it a file of its own`);
    return problems;
  }
  for (const { name, isType } of exports) if (isType) problems.push(`${file}: exports the type ${name}: types go in the folder's ${TYPES_FILE}`);
  const values = exports.filter(({ isType }) => !isType);
  if (values.length !== 1) problems.push(`${file}: exports ${values.length} values (${values.map(({ name }) => name).join(", ")}): one per file`);
  else if (!sameName(base, values[0]!.name)) problems.push(`${file}: exports ${values[0]!.name}: name the file after its export`);
  return problems;
}
