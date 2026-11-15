import { basename, extname } from "node:path";

/**
 * What AOP knows how to run headless and read the output of. Anything else is `other`, which gets
 * plain `-p` and shows its log as it is.
 */
export type AgentTool = "claude" | "other";

/** How a run's log is written, which decides how its tail is read. */
export type OutputFormat = "stream-json" | "text";

/**
 * What AOP adds to `agent_session_command` so that an agent runs without a terminal, with its prompt
 * on stdin. The one place the flags are chosen: Claude Code also streams JSON events, which carry
 * the token usage that context consumed is read from. `--verbose` is required with stream-json in
 * `-p` mode.
 */
export const HEADLESS_AGENT_FLAGS: Record<AgentTool, string> = {
  claude: "-p --output-format stream-json --verbose",
  other: "-p",
};

export const OUTPUT_FORMATS: Record<AgentTool, OutputFormat> = {
  claude: "stream-json",
  other: "text",
};

/** Programs that start another program, so the tool is whatever they're given. */
const LAUNCHERS = new Set(["node", "npx", "bunx", "pnpx", "env", "exec", "sudo", "nice", "nohup", "cmd", "sh", "bash", "zsh", "pwsh", "powershell"]);

/** Splits a command line into words, keeping quoted parts together. Good enough to find the program. */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * Which tool a command runs, from the name of the program it starts. Wrappers count by name, so
 * `sandboxed-claude` is Claude Code. Only the program decides, never its arguments, so
 * `copilot --model claude-sonnet` isn't. Paths are cut to the file name, so a folder named
 * `.claude` doesn't count either.
 */
export function agentToolFor(command: string): AgentTool {
  for (const word of words(command)) {
    // Flags, VAR=value settings and cmd switches such as /c come before the program.
    if (word === "" || word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^\/[a-z]$/i.test(word)) continue;
    const name = basename(word.replaceAll("\\", "/")).toLowerCase();
    const program = name.slice(0, name.length - extname(name).length);
    if (LAUNCHERS.has(program)) continue;
    return program.includes("claude") ? "claude" : "other";
  }
  return "other";
}

export function headlessCommand(command: string): { command: string; tool: AgentTool; format: OutputFormat } {
  const tool = agentToolFor(command);
  return { command: `${command} ${HEADLESS_AGENT_FLAGS[tool]}`, tool, format: OUTPUT_FORMATS[tool] };
}

export interface Usage {
  /** The context size of the latest main-conversation turn: input plus cache-read and cache-creation tokens. */
  context: number | null;
  output: number | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

function parseLine(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) && typeof value["type"] === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Subagents run in their own context, so only the main conversation's turns say how full it is. */
const isMainThread = (event: Json) => event["parent_tool_use_id"] === null || event["parent_tool_use_id"] === undefined;

/**
 * Reads Claude Code's stream-json output as it arrives and keeps the run's token usage. One API
 * turn can be streamed as several `assistant` events sharing a `message.id`, each repeating the
 * usage, so output is counted once per message, and the final `result` replaces that total.
 */
export class StreamJsonUsage {
  private pending = "";
  private readonly outputByMessage = new Map<string, number>();
  private finalOutput: number | null = null;
  context: number | null = null;

  /** Feeds output in. Returns true when the usage changed. */
  write(chunk: string): boolean {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) changed = this.read(line) || changed;
    return changed;
  }

  /** Reads whatever is left once output has ended. */
  end(): boolean {
    const rest = this.pending;
    this.pending = "";
    return rest === "" ? false : this.read(rest);
  }

  get usage(): Usage {
    const sum = [...this.outputByMessage.values()].reduce((total, value) => total + value, 0);
    return { context: this.context, output: this.finalOutput ?? (this.outputByMessage.size > 0 ? sum : null) };
  }

  private read(line: string): boolean {
    const event = parseLine(line);
    if (!event) return false;
    if (event["type"] === "assistant" && isMainThread(event) && isObject(event["message"])) {
      const message = event["message"];
      const usage = message["usage"];
      if (!isObject(usage)) return false;
      this.context =
        count(usage["input_tokens"]) + count(usage["cache_read_input_tokens"]) + count(usage["cache_creation_input_tokens"]);
      const id = typeof message["id"] === "string" ? message["id"] : `#${this.outputByMessage.size}`;
      this.outputByMessage.set(id, count(usage["output_tokens"]));
      return true;
    }
    if (event["type"] === "result" && isObject(event["usage"]) && typeof event["usage"]["output_tokens"] === "number") {
      this.finalOutput = count(event["usage"]["output_tokens"]);
      return true;
    }
    return false;
  }
}

const MAX_LINE = 400;

function clip(text: string, length = MAX_LINE): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** The input field that best says what a tool call is doing. */
const TOOL_SUMMARY_FIELDS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill"];

function toolBrief(block: Json): string {
  const name = typeof block["name"] === "string" ? block["name"] : "tool";
  const input = isObject(block["input"]) ? block["input"] : {};
  const field = TOOL_SUMMARY_FIELDS.find((key) => typeof input[key] === "string" && input[key] !== "");
  return field ? `${name}: ${clip(input[field] as string, 160)}` : name;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isObject(part) && typeof part["text"] === "string" ? part["text"] : "")).join(" ");
  }
  return "";
}

/** One stream-json event as lines a person can read, or none for events that are only noise. */
function readableEvent(event: Json): string[] {
  const content = isObject(event["message"]) && Array.isArray(event["message"]["content"]) ? event["message"]["content"] : [];
  switch (event["type"]) {
    case "system":
      if (event["subtype"] === "init") return [`Session started${typeof event["model"] === "string" ? `, ${event["model"]}` : ""}`];
      if (event["subtype"] === "api_retry") return [`Retrying the API, attempt ${count(event["attempt"])}`];
      return [];
    case "assistant": {
      const main = isMainThread(event);
      const lines: string[] = [];
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block["type"] === "text" && main && typeof block["text"] === "string") {
          for (const part of block["text"].split(/\r?\n/)) if (part.trim() !== "") lines.push(clip(part));
        } else if (block["type"] === "tool_use") {
          lines.push(`${main ? "" : "  "}→ ${toolBrief(block)}`);
        }
      }
      return lines;
    }
    case "user":
      return content
        .filter((block): block is Json => isObject(block) && block["type"] === "tool_result" && block["is_error"] === true)
        .map((block) => `${isMainThread(event) ? "" : "  "}✗ ${clip(resultText(block["content"]), 200)}`);
    case "result": {
      if (event["subtype"] === "success" && typeof event["result"] === "string") {
        const lines = event["result"].split(/\r?\n/).filter((part) => part.trim() !== "").map((part) => clip(part));
        return [`Result:${lines.length === 0 ? " (empty)" : ""}`, ...lines];
      }
      const errors = Array.isArray(event["errors"]) ? event["errors"].filter((e) => typeof e === "string") : [];
      return [`Ended: ${String(event["subtype"] ?? "error")}${errors.length > 0 ? `, ${clip(errors.join("; "), 200)}` : ""}`];
    }
    default:
      return [];
  }
}

/** A log's lines as a person would want to read them. Lines that aren't events, such as AOP's own, stay as they are. */
export function readableLines(lines: string[], format: OutputFormat): string[] {
  if (format === "text") return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "");
  return lines.flatMap((line) => {
    const event = parseLine(line);
    if (event) return readableEvent(event);
    const plain = line.replace(/\r$/, "");
    return plain.trim() === "" ? [] : [clip(plain)];
  });
}
