import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installed, sourceCheckout } from "./selfBuild.js";

const LOCK = { packages: { "": { name: "aop" }, "node_modules/zod": { version: "4.0.0" } } };

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const ago = (seconds: number) => Date.now() / 1000 - seconds;

/** Writes `file` under `root`, last modified `age` seconds ago. */
function put(root: string, file: string, age: number, content = ""): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, ago(age), ago(age));
}

/** A checkout with its packages installed. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "aop-selfbuild-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  put(root, "package.json", 200, "{}");
  put(root, "package-lock.json", 200, JSON.stringify(LOCK));
  put(root, "node_modules/.package-lock.json", 150, JSON.stringify(LOCK));
  put(root, "src/cli/cli.ts", 200);
  put(root, "web/src/main.tsx", 200);
  return root;
}

const main = (root: string) => join(root, "dist", "cli", "main.js");

describe("sourceCheckout", () => {
  it("finds the checkout a dist build runs from", () => {
    const root = checkout();
    expect(sourceCheckout(main(root))).toBe(root);
  });

  it("skips an installed package, which has no sources", () => {
    const root = checkout();
    rmSync(join(root, "src"), { recursive: true });
    expect(sourceCheckout(main(root))).toBeNull();
  });

  it("skips a folder that isn't a git checkout", () => {
    const root = checkout();
    rmSync(join(root, ".git"), { recursive: true });
    expect(sourceCheckout(main(root))).toBeNull();
  });

  it("skips running from the sources", () => {
    const root = checkout();
    expect(sourceCheckout(join(root, "src", "cli", "main.ts"))).toBeNull();
  });
});

describe("installed", () => {
  it("is happy when node_modules has what the lockfile asks for", () => {
    expect(installed(checkout())).toBe(true);
  });

  it("installs when the lockfile asks for packages node_modules doesn't have", () => {
    const root = checkout();
    const lock = { packages: { ...LOCK.packages, "node_modules/zod": { version: "4.1.0" } } };
    put(root, "package-lock.json", 10, JSON.stringify(lock));
    expect(installed(root)).toBe(false);
  });

  it("installs when node_modules is missing", () => {
    const root = checkout();
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(installed(root)).toBe(false);
  });

  it("doesn't install optional packages for other platforms", () => {
    const root = checkout();
    const lock = { packages: { ...LOCK.packages, "node_modules/@esbuild/aix-ppc64": { version: "1.0.0", optional: true } } };
    put(root, "package-lock.json", 200, JSON.stringify(lock));
    expect(installed(root)).toBe(true);
  });
});
