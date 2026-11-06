/**
 * A small markdown reader for hand-written pages such as the roadmap. It covers headings, paragraphs,
 * lists, fenced code, rules and simple inline marks. It never produces HTML: the result is a tree that
 * React renders as text, so any HTML in the source shows as literal characters. HTML comments are
 * dropped, as markdown renderers usually do.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

/** A list item, with any lists indented under it. */
export interface ListItem {
  children: Inline[];
  lists?: ListBlock[];
}

export interface ListBlock {
  kind: "list";
  ordered: boolean;
  items: ListItem[];
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | ListBlock
  | { kind: "code"; text: string }
  | { kind: "rule" };

const HEADING = /^(#{1,6})\s+(.*)$/;
/** An optional closing run of `#`, which only counts after a space, so `# C#` keeps its `#`. */
const CLOSING_HASHES = /(^|\s+)#+\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```")) body.push(lines[i++] ?? "");
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: "heading", level, children: parseInline((heading[2] ?? "").replace(CLOSING_HASHES, "").trim()) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = readList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    const text: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "" || HEADING.test(current) || FENCE.test(current) || RULE.test(current)) break;
      if (LIST_ITEM.test(current)) break;
      text.push(current.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(text.join(" ")) });
  }
  return blocks;
}

const indentOf = (space: string) => space.replace(/\t/g, "    ").length;

/**
 * Reads the list whose first item is at `start`. An item indented further than that starts a list
 * under the item before it; a less indented item, a different kind of marker or a blank line ends it.
 */
function readList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? "");
  const indent = indentOf(first?.[1] ?? "");
  const ordered = /\d/.test(first?.[2] ?? "");
  const items: { text: string; lists: ListBlock[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const item = LIST_ITEM.exec(line);
    const last = items[items.length - 1];
    if (item) {
      const at = indentOf(item[1] ?? "");
      if (at > indent && last) {
        const nested = readList(lines, i);
        last.lists.push(nested.block);
        i = nested.next;
        continue;
      }
      if (at < indent || /\d/.test(item[2] ?? "") !== ordered) break;
      items.push({ text: item[3] ?? "", lists: [] });
    } else if (line.trim() !== "" && /^\s+/.test(line) && last) {
      last.text += ` ${line.trim()}`;
    } else break;
    i++;
  }
  const block: ListBlock = {
    kind: "list",
    ordered,
    items: items.map(({ text, lists }) => ({ children: parseInline(text), ...(lists.length > 0 ? { lists } : {}) })),
  };
  return { block, next: i };
}

/** Only links that can't run script are kept; anything else stays as plain text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed) || /^[/#]/.test(trimmed)) return trimmed;
  return null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "text", text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ kind: "code", text: code[1] ?? "" });
      i += code[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ kind: "strong", children: parseInline(strong[2] ?? "") });
      i += strong[0].length;
      continue;
    }
    const em = /^(\*|_)(?!\s)(.+?)\1/.exec(rest);
    if (em && (em[1] === "*" || !/\w/.test(text[i - 1] ?? ""))) {
      flush();
      out.push({ kind: "em", children: parseInline(em[2] ?? "") });
      i += em[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2] ?? "");
      flush();
      if (href) out.push({ kind: "link", href, children: parseInline(link[1] ?? "") });
      else out.push(...parseInline(link[1] ?? ""));
      i += link[0].length;
      continue;
    }
    plain += text[i];
    i++;
  }
  flush();
  return out;
}
