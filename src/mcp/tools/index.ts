// Every tool the MCP server offers, all of them agent commands. Adding one is a new file here, plus
// its import and its entry in `TOOLS`.

import type { AopTool } from "../tool.js";
import { ask } from "./ask.js";
import { context } from "./context.js";
import { edge_add } from "./edge_add.js";
import { edge_remove } from "./edge_remove.js";
import { fail } from "./fail.js";
import { link } from "./link.js";
import { message } from "./message.js";
import { next } from "./next.js";
import { nodeCreate } from "./node_create.js";
import { nodeEdit } from "./node_edit.js";
import { search } from "./search.js";
import { splitFinish } from "./split_finish.js";
import { splitStart } from "./split_start.js";

export const TOOLS: readonly AopTool[] = [
  ask,
  context,
  edge_add,
  edge_remove,
  fail,
  link,
  message,
  next,
  nodeCreate,
  nodeEdit,
  search,
  splitFinish,
  splitStart,
];
