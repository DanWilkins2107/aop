import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../web/src/lib/markdown.js";

const text = (value: string) => ({ kind: "text", text: value });

describe("markdown", () => {
  it("reads headings, lists, paragraphs and inline marks", () => {
    expect(parseMarkdown("# Title\n\nSome **bold**, *soft* and `code`.\n\n- one\n- two\n\n1. first")).toEqual([
      { kind: "heading", level: 1, children: [text("Title")] },
      {
        kind: "paragraph",
        children: [
          text("Some "),
          { kind: "strong", children: [text("bold")] },
          text(", "),
          { kind: "em", children: [text("soft")] },
          text(" and "),
          { kind: "code", text: "code" },
          text("."),
        ],
      },
      { kind: "list", ordered: false, items: [[text("one")], [text("two")]] },
      { kind: "list", ordered: true, items: [[text("first")]] },
    ]);
  });

  it("keeps raw HTML as plain text, which React then escapes", () => {
    expect(parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">')).toEqual([
      { kind: "paragraph", children: [text("<script>alert(1)</script>")] },
      { kind: "paragraph", children: [text('<img src=x onerror="alert(1)">')] },
    ]);
  });

  it("keeps safe links and turns script links into plain text", () => {
    expect(parseMarkdown("[site](https://example.com) [bad](javascript:alert`1`)")).toEqual([
      {
        kind: "paragraph",
        children: [{ kind: "link", href: "https://example.com", children: [text("site")] }, text(" "), text("bad")],
      },
    ]);
  });

  it("drops a closing run of # only when a space comes before it", () => {
    expect(parseMarkdown("## Title ##\n\n# Learn C#\n\n# ##")).toEqual([
      { kind: "heading", level: 2, children: [text("Title")] },
      { kind: "heading", level: 1, children: [text("Learn C#")] },
      { kind: "heading", level: 1, children: [] },
    ]);
  });

  it("reads links and marks inside headings", () => {
    expect(parseMarkdown("### See [the **spec**](/specs) #")).toEqual([
      {
        kind: "heading",
        level: 3,
        children: [
          text("See "),
          { kind: "link", href: "/specs", children: [text("the "), { kind: "strong", children: [text("spec")] }] },
        ],
      },
    ]);
  });

  it("joins wrapped lines of a paragraph and of a list item", () => {
    expect(parseMarkdown("one\ntwo\n\n- first\n  continued\n- second")).toEqual([
      { kind: "paragraph", children: [text("one two")] },
      { kind: "list", ordered: false, items: [[text("first continued")], [text("second")]] },
    ]);
  });

  it("keeps snake_case words whole", () => {
    expect(parseMarkdown("use return_stage here")).toEqual([{ kind: "paragraph", children: [text("use return_stage here")] }]);
  });

  it("drops HTML comments, so the roadmap's editing note stays hidden", () => {
    const blocks = parseMarkdown(readFileSync("docs/roadmap.md", "utf8"));
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, children: [text("Roadmap")] });
    expect(JSON.stringify(blocks)).not.toContain("edits this file");
  });
});
