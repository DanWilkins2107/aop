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

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
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
      blocks.push({ kind: "heading", level, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      const marker = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const item = marker.exec(current);
        if (item) items.push(item[1] ?? "");
        else if (current.trim() !== "" && /^\s+/.test(current) && items.length > 0) {
          items[items.length - 1] += ` ${current.trim()}`;
        } else break;
        i++;
      }
      blocks.push({ kind: "list", ordered, items: items.map((item) => parseInline(item)) });
      continue;
    }
    const text: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "" || HEADING.test(current) || FENCE.test(current) || RULE.test(current)) break;
      if (BULLET.test(current) || NUMBERED.test(current)) break;
      text.push(current.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(text.join(" ")) });
  }
  return blocks;
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
