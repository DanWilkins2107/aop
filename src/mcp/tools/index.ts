// Every tool the MCP server offers, all of them agent commands. Adding one is a new file here, plus
// its import and its entry in `TOOLS`.

import type { AopTool } from "../tool.js";
import { ask } from "./ask.js";
import { context } from "./context.js";
import { message } from "./message.js";
import { next } from "./next.js";

export const TOOLS: readonly AopTool[] = [
  ask,
  context,
  message,
  next,
];
