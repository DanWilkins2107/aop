import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { extendable } from "../../web/src/extendable/extendable.js";
import type { ExtendableProps } from "../../web/src/extendable/types.js";

// The build fills this module from the extensions in config.
vi.mock("virtual:aop-overrides", () => ({
  default: [
    {
      extension: "shout",
      id: "aop.test.Greeting",
      version: 1,
      component: ({ name, Original }: ExtendableProps<ComponentType<{ name: string }>>) =>
        createElement(Original, { name: name.toUpperCase() }),
    },
  ],
}));

describe("extendable", () => {
  it("applies the overrides the build serves", () => {
    const Greeting = extendable("aop.test.Greeting", 1, ({ name }: { name: string }) => createElement("b", null, name));
    expect(renderToStaticMarkup(createElement(Greeting, { name: "Ada" }))).toBe("<b>ADA</b>");
  });
});
