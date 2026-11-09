// Every tool the MCP server offers, all of them agent commands. Adding one is a new file here, plus
// its import and its entry in `TOOLS`.

import type { AopTool } from "../tool.js";
import { ask } from "./ask.js";
import { context } from "./context.js";
import { fail } from "./fail.js";
import { link } from "./link.js";
import { message } from "./message.js";
import { next } from "./next.js";
import { nodeEdit } from "./node_edit.js";

export const TOOLS: readonly AopTool[] = [
  ask,
  context,
  fail,
  link,
  message,
  next,
  nodeEdit,
];
