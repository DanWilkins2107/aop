import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBuild, sourceCheckout } from "../../src/cli/selfBuild.js";

const OUTPUTS = ["dist/cli/main.js", "dist/server/main.js", "dist/web/index.html"];
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

/** A checkout built 100s ago from sources 200s old, with its packages installed. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "aop-selfbuild-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  put(root, "package.json", 200, "{}");
  put(root, "package-lock.json", 200, JSON.stringify(LOCK));
  put(root, "node_modules/.package-lock.json", 150, JSON.stringify(LOCK));
  put(root, "src/cli/cli.ts", 200);
  put(root, "web/src/main.tsx", 200);
  for (const file of OUTPUTS) put(root, file, 100);
  // A folder changes when a file in it is added or removed, so age the folders too.
  for (const dir of ["src", "src/cli", "web", "web/src"]) utimesSync(join(root, dir), ago(200), ago(200));
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

describe("checkBuild", () => {
  it("is happy with a build newer than its sources", () => {
    expect(checkBuild(checkout())).toEqual({ install: false, build: null });
  });

  it("rebuilds when a source file changed", () => {
    const root = checkout();
    put(root, "src/cli/cli.ts", 10);
    expect(checkBuild(root)).toEqual({ install: false, build: "sources changed" });
  });

  it("rebuilds when a web file or a config file changed", () => {
    const web = checkout();
    put(web, "web/src/main.tsx", 10);
    expect(checkBuild(web).build).toBe("sources changed");
    const config = checkout();
    put(config, "vite.config.ts", 10);
    expect(checkBuild(config).build).toBe("sources changed");
  });

  it("rebuilds when a source file was deleted", () => {
    const root = checkout();
    rmSync(join(root, "src", "cli", "cli.ts"));
    expect(checkBuild(root).build).toBe("sources changed");
  });

  it("builds when part of the build is missing", () => {
    const root = checkout();
    rmSync(join(root, "dist", "web"), { recursive: true });
    expect(checkBuild(root).build).toBe("no build yet");
  });

  it("rebuilds after a half-finished build", () => {
    const root = checkout();
    put(root, "src/cli/cli.ts", 50);
    put(root, "dist/cli/main.js", 10);
    expect(checkBuild(root).build).toBe("sources changed");
  });

  it("installs when the lockfile asks for packages node_modules doesn't have", () => {
    const root = checkout();
    const lock = { packages: { ...LOCK.packages, "node_modules/zod": { version: "4.1.0" } } };
    put(root, "package-lock.json", 10, JSON.stringify(lock));
    expect(checkBuild(root)).toEqual({ install: true, build: "sources changed" });
  });

  it("installs when node_modules is missing", () => {
    const root = checkout();
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(checkBuild(root)).toEqual({ install: true, build: "packages changed" });
  });

  it("doesn't install optional packages for other platforms", () => {
    const root = checkout();
    const lock = { packages: { ...LOCK.packages, "node_modules/@esbuild/aix-ppc64": { version: "1.0.0", optional: true } } };
    put(root, "package-lock.json", 200, JSON.stringify(lock));
    expect(checkBuild(root)).toEqual({ install: false, build: null });
  });
});
