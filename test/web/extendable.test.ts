import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { extendable } from "../../web/src/extendable/extendable.js";
import { stackOverrides } from "../../web/src/extendable/stackOverrides.js";
import type { ExtendableProps, OverrideLayer } from "../../web/src/extendable/types.js";

type Props = { name: string };
const Base: ComponentType<Props> = ({ name }) => createElement("b", null, name);

const wrap = (extension: string): OverrideLayer => ({
  extension,
  id: "aop.test.Greeting",
  version: 1,
  component: ({ Original, ...props }: ExtendableProps<typeof Base>) =>
    createElement("span", { "data-by": extension }, createElement(Original, props)),
});
const render = (C: ComponentType<Props>) => renderToStaticMarkup(createElement(C, { name: "Ada" }));

describe("stackOverrides", () => {
  it("leaves the component as it is with no overrides for its ID", () => {
    expect(stackOverrides("aop.test.Greeting", 1, Base, [{ ...wrap("x"), id: "aop.test.Other" }])).toBe(Base);
  });

  it("stacks wraps in config order, each one's Original being the layer below", () => {
    const Stacked = stackOverrides("aop.test.Greeting", 1, Base, [wrap("first"), wrap("second")]);
    expect(render(Stacked)).toBe('<span data-by="second"><span data-by="first"><b>Ada</b></span></span>');
    expect(Stacked.displayName).toBe("aop.test.Greeting (second)");
  });

  it("lets an override replace everything below it by not rendering Original", () => {
    const replace: OverrideLayer = { ...wrap("r"), component: ({ name }: Props) => createElement("i", null, name) };
    expect(render(stackOverrides("aop.test.Greeting", 1, Base, [wrap("below"), replace]))).toBe("<i>Ada</i>");
  });

  it("warns on a version mismatch but still applies the override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Stacked = stackOverrides("aop.test.Greeting", 2, Base, [wrap("old")]);
    expect(render(Stacked)).toBe('<span data-by="old"><b>Ada</b></span>');
    expect(warn).toHaveBeenCalledWith("old overrides aop.test.Greeting v1, but AOP's aop.test.Greeting is v2.");
    warn.mockRestore();
  });
});

describe("extendable", () => {
  it("serves no overrides before any extension is built in", () => {
    expect(extendable("aop.test.Greeting", 1, Base)).toBe(Base);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("extendable IDs", () => {
  const ids = sources("web/src").flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/extendable\(\s*"([^"]*)"/g)].map((match) => match[1]),
  );

  it("are dotted aop.<area>.<Name>", () => {
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^aop\.[a-z][a-zA-Z]*\.[A-Z][a-zA-Z0-9]*$/);
  });

  it("are unique", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
});
