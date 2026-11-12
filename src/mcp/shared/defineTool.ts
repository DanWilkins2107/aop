// What every MCP tool is made with: its definition turned into a registered tool, and the API's
// answers and errors turned into tool results.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiFailure, type ToolApi } from "./toolApi.js";

/** One tool, ready to register. Made with `defineTool`. */
export interface AopTool {
  name: string;
  register(server: McpServer, api: ToolApi): void;
}

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  /** snake_case, with no `aop` prefix: clients add the server's name themselves. */
  name: string;
  /** What the agent reads to decide when and how to use the tool. */
  description: string;
  /** Each argument, with a `.describe()` the agent reads. A write tool's `run_id` is added for it. */
  input: Shape;
  /**
   * A tool that changes anything. It takes a required `run_id`, and every API call it makes is sent
   * as from that run, so the server's run guard applies to it.
   */
  writes?: boolean;
  annotations?: ToolAnnotations;
  /** Returns the text the agent sees, or a whole result. Throw `ApiFailure` (as `api` does) to fail. */
  run(args: z.output<z.ZodObject<Shape>>, api: ToolApi): Promise<string | CallToolResult>;
}

/** The argument every write tool takes. */
export const RUN_ID_ARG = {
  run_id: z
    .string()
    .trim()
    .min(1)
    .describe("Your run ID, from your prompt. In a session `aop steer` opened, it's in AOP_RUN_ID."),
};

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** A write tool's input: its own, with `run_id` after `node_id`. */
function withRunId(shape: z.ZodRawShape): z.ZodRawShape {
  const { node_id, ...rest } = shape;
  return { ...(node_id !== undefined ? { node_id } : {}), ...RUN_ID_ARG, ...rest };
}

/** Makes a tool whose API failures become tool errors carrying the API's message. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): AopTool {
  const shape = tool.writes === true ? withRunId(tool.input) : tool.input;
  return {
    name: tool.name,
    register(server, api) {
      const input = z.object(shape);
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: shape, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
        (async (raw: unknown) => {
          try {
            const args = input.parse(raw) as z.output<z.ZodObject<Shape>> & { run_id?: string };
            const result = await tool.run(args, tool.writes === true ? api.asRun(args.run_id ?? "") : api);
            return typeof result === "string" ? textResult(result) : result;
          } catch (error) {
            if (error instanceof ApiFailure) return textResult(error.message, true);
            throw error;
          }
        }) as never,
      );
    },
  };
}
