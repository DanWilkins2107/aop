/// <reference path="./overrides.d.ts" />
import type { ComponentType } from "react";
import overrides from "virtual:aop-overrides";
import { stackOverrides } from "./stackOverrides.js";

/**
 * Makes `Base` overridable by extensions under `id`, a dotted `aop.<area>.<Name>`. Bump `version`
 * when the props' meaning changes: an override written against another version still loads, with a
 * warning. Call it at module level, so the component keeps one identity.
 */
export function extendable<P extends object>(id: string, version: number, Base: ComponentType<P>): ComponentType<P> {
  return stackOverrides(id, version, Base, overrides);
}
