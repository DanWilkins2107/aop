import { Fragment, type ReactNode } from "react";
import { extendable } from "../extendable/extendable.js";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown.js";

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a key={index} href={node.href} rel="noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.level}` as const;
      return <Tag key={index}>{renderInline(block.children)}</Tag>;
    }
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>
          {renderInline(item.children)}
          {item.lists?.map(renderBlock)}
        </li>
      ));
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case "code":
      return (
        <pre key={index}>
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={index} />;
  }
}

/**
 * Renders markdown as React text nodes only, so HTML in the source is shown, never run.
 * `inline` puts a single paragraph in a span, so a one-line reason can follow other text on its line.
 */
export const Markdown = extendable("aop.common.Markdown", 1, function Markdown({
  source,
  inline = false,
}: {
  source: string;
  inline?: boolean;
}) {
  const blocks = parseMarkdown(source);
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (inline && only?.kind === "paragraph") return <span className="markdown">{renderInline(only.children)}</span>;
  return <div className="markdown">{blocks.map(renderBlock)}</div>;
});
