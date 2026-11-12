import path from "node:path";
import { IMPORT } from "./importBoundaryGate.js";

/** The only files of a folder that anything outside it may import, by folder. */
export type Surfaces = Record<string, string[]>;

/** The imports, from code or tests, that reach into a folder past its public files. */
export function publicSurfaceProblems(sources: Record<string, string>, surfaces: Surfaces): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (!specifier!.startsWith(".")) continue;
      const target = path.posix.join(path.posix.dirname(file), specifier!).replace(/\.js$/, ".ts");
      for (const [folder, open] of Object.entries(surfaces)) {
        if (target.startsWith(`${folder}/`) && !file.startsWith(`${folder}/`) && !open.includes(target)) {
          problems.push(`${file}: imports ${specifier}, which isn't one of ${folder}'s public files (${open.join(", ")})`);
        }
      }
    }
  }
  return problems;
}
