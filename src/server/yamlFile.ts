import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

export type YamlResult = { ok: true; value: unknown } | { ok: false; problems: string[] };

export function parseYamlFile(path: string): YamlResult {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : String(error);
    return { ok: false, problems: [`${path}: ${reason}`] };
  }
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return { ok: false, problems: doc.errors.map((e) => `${path}: ${e.message}`) };
  }
  return { ok: true, value: doc.toJS() as unknown };
}
