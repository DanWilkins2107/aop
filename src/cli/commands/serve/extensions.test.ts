import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExtensions } from "./extensions.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aop-extensions-")));
  dirs.push(dir);
  return dir;
}

function put(path: string, content = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A home whose config.yaml lists `paths`, and a folder to make extensions in. */
function setup(paths: string[]): { home: string; code: string } {
  const home = tempDir();
  const code = tempDir();
  put(join(home, "config.yaml"), `stages: ./stages.yaml\nextensions:\n${paths.map((p) => `  - ${JSON.stringify(join(code, p))}\n`).join("")}`);
  return { home, code };
}

const problems = (home: string) => {
  const result = readExtensions(home);
  return result.ok ? [] : result.problems.join("\n");
};

describe("readExtensions", () => {
  it("is none with no config, or none listed", () => {
    expect(readExtensions(tempDir())).toEqual({ ok: true, extensions: [] });
    const home = tempDir();
    put(join(home, "config.yaml"), "stages: ./stages.yaml\n");
    expect(readExtensions(home)).toEqual({ ok: true, extensions: [] });
  });

  it("reads each extension's name and entries, in config order", () => {
    const { home, code } = setup(["beta", "alpha-2"]);
    put(join(code, "beta", "server", "index.ts"));
    put(join(code, "beta", "web", "index.tsx"));
    put(join(code, "alpha-2", "mcp", "index.ts"));
    expect(readExtensions(home)).toEqual({
      ok: true,
      extensions: [
        { name: "beta", path: join(code, "beta"), entries: ["web", "server"] },
        { name: "alpha-2", path: join(code, "alpha-2"), entries: ["mcp"] },
      ],
    });
  });

  it("refuses a folder that's missing, badly named or has no entries", () => {
    const { home, code } = setup(["missing", "Bad_Name", "empty"]);
    put(join(code, "Bad_Name", "cli", "index.ts"));
    put(join(code, "empty", "README.md"));
    const found = problems(home);
    expect(found).toContain("extensions[0]");
    expect(found).toContain(`${join(code, "missing")} isn't a folder`);
    expect(found).toContain(`"Bad_Name", must be lowercase`);
    expect(found).toContain(`${join(code, "empty")} has none of web/index.tsx`);
  });

  it("refuses two extensions with one name", () => {
    const { home, code } = setup(["a/ext", "b/ext"]);
    put(join(code, "a", "ext", "cli", "index.ts"));
    put(join(code, "b", "ext", "cli", "index.ts"));
    expect(problems(home)).toContain(`extensions[1]: ${join(code, "b", "ext")} has the same name as ${join(code, "a", "ext")}`);
  });

  it("refuses an extension with a link in it, which could reach outside", () => {
    const { home, code } = setup(["ext"]);
    put(join(code, "ext", "server", "index.ts"));
    mkdirSync(join(code, "elsewhere"));
    symlinkSync(join(code, "elsewhere"), join(code, "ext", "server", "lib"), "junction");
    expect(problems(home)).toContain(`${join(code, "ext", "server", "lib")} is a link`);
  });

  it("refuses an extensions setting that isn't a list", () => {
    const home = tempDir();
    put(join(home, "config.yaml"), "extensions: ~/code/ext\n");
    expect(problems(home)).toContain("extensions: must be a list of folders");
  });
});
