#!/usr/bin/env node
// `aop`, on the real process. The commands are in `cli.ts`.

import { runCli } from "./cli.js";

await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => {
    // Not `process.exit`: `serve` keeps running after its command returns.
    process.exitCode = code;
  },
});
