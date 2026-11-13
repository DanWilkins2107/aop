import type { Command, Usage } from "../shared/command.js";
import { init } from "./init/init.js";
import { logs } from "./logs.js";
import { project } from "./project.js";
import { ps } from "./ps.js";
import { reap } from "./reap.js";
import { release } from "./release.js";
import { serve } from "./serve/serve.js";
import { steer } from "./steer.js";
import { stop } from "./stop.js";

/** Every `aop` command, in the order the help lists them. */
export const COMMANDS: readonly Command[] = [init, project, serve, steer, stop, release, logs, ps, reap];

/** Each command's usage, by name. */
export const HUMAN_COMMANDS: Readonly<Record<string, Usage>> = Object.fromEntries(COMMANDS.map((command) => [command.name, command.usage]));
