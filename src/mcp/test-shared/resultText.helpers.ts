import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The text of a tool result, success or error. */
export const resultText = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
