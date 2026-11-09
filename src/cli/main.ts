#!/usr/bin/env node
// `aop`, on the real process. The commands are in `cli.ts`.

import { fileURLToPath } from "node:url";
import { serveFreshBuild } from "./selfBuild.js";

const argv = process.argv.slice(2);
// Before loading the commands, so a rebuild can replace them first.
if (!(argv[0] === "serve" && (await serveFreshBuild(fileURLToPath(import.meta.url), argv, process.env)))) {
  const { runCli } = await import("./cli.js");
  await runCli({
    argv,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    exit: (code) => {
      // Not `process.exit`: `serve` keeps running after its command returns.
      process.exitCode = code;
    },
  });
}
