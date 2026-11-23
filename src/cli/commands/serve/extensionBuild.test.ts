import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildExtensions, extensionsDir } from "./extensionBuild.js";
import type { Extension } from "./extensions.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aop-extension-build-")));
  dirs.push(dir);
  return dir;
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A checkout to build into, using this repo's packages. */
function checkout(): string {
  const root = tempDir();
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
  return root;
}

function extension(name: string, files: Record<string, string>): Extension {
  const path = join(tempDir(), name);
  for (const [file, content] of Object.entries(files)) put(join(path, file), content);
  const entries = (["web", "server", "cli", "mcp"] as const).filter((kind) => Object.keys(files).some((f) => f.startsWith(`${kind}/index.`)));
  return { name, path, entries };
}

const Record = z.object({
  extensions: z.array(z.object({ name: z.string(), entries: z.record(z.string(), z.string()), files: z.array(z.string()), commit: z.string().nullable() })),
  problems: z.array(z.string()),
});
const record = (root: string) => Record.parse(JSON.parse(readFileSync(join(extensionsDir(root), "extension-build.json"), "utf8")));

describe("buildExtensions", { timeout: 60_000 }, () => {
  it("compiles server and web entries from a copy, and records them", () => {
    const root = checkout();
    const ext = extension("hello", {
      "server/index.ts": 'import { greet } from "./greet.js";\nexport default { greeting: greet("server") };\n',
      "server/greet.ts": "export const greet = (who: string): string => `hello ${who}`;\n",
      "web/index.tsx": 'import { useState } from "react";\nexport default function Hello() {\n  const [n] = useState(1);\n  return <b>{n}</b>;\n}\n',
      "package.json": '{ "type": "commonjs" }',
      "node_modules/junk/index.js": "",
    });
    const log: string[] = [];
    expect(buildExtensions(root, [ext], (line) => {
      log.push(line);
    })).toEqual([]);

    const out = join(extensionsDir(root), "hello");
    expect(readFileSync(join(out, "server", "index.js"), "utf8")).toContain('from "./greet.js"');
    expect(existsSync(join(out, "web", "index.js"))).toBe(true);
    const [built] = record(root).extensions;
    expect(built).toMatchObject({ name: "hello", commit: null, entries: { web: "web/index.js", server: "server/index.js" } });
    expect(built?.files.toSorted()).toEqual(["server/greet.ts", "server/index.ts", "web/index.tsx"]);
    expect(log.join("\n")).toContain("server/greet.ts");
  });

  it("refuses an extension with a type error, naming it", () => {
    const root = checkout();
    const ext = extension("broken", { "cli/index.ts": "const n: number = 'no';\nexport default n;\n" });
    const problems = buildExtensions(root, [ext], () => {});
    expect(problems.join("\n")).toContain(`Extension "broken" (${ext.path}) didn't compile`);
    expect(record(root).problems).toEqual(problems);
    expect(existsSync(join(extensionsDir(root), "broken", "cli", "index.js"))).toBe(false);
  });

  it("refuses code outside the extension's folder", () => {
    const root = checkout();
    const ext = extension("reach", { "mcp/index.ts": 'export { x } from "../../outside.js";\n' });
    put(join(dirname(ext.path), "outside.ts"), "export const x = 1;\n");
    const problems = buildExtensions(root, [ext], () => {}).join("\n");
    expect(problems).toContain('Extension "reach"');
    expect(problems).toContain("../../outside.js");
  });

  it("drops an earlier build, so a removed extension's code goes", () => {
    const root = checkout();
    const ext = extension("gone", { "cli/index.ts": "export default 1;\n" });
    expect(buildExtensions(root, [ext], () => {})).toEqual([]);
    expect(buildExtensions(root, [], () => {})).toEqual([]);
    expect(existsSync(join(extensionsDir(root), "gone"))).toBe(false);
    expect(record(root).extensions).toEqual([]);
  });
});
