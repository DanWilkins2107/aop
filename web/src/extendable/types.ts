import type { ComponentType } from "react";

/** What an override of `C` gets: `C`'s own props, plus `Original`, the layer below it. */
export type ExtendableProps<C> = C extends ComponentType<infer P> ? P & { Original: ComponentType<P> } : never;

/** A component that wraps `Original` by rendering it, or replaces it by not. */
export type Override<C> = ComponentType<ExtendableProps<C>>;

/** One extension's override of one extendable ID. Layers stack in config order, the last on top. */
export interface OverrideLayer {
  extension: string;
  id: string;
  /** The ID's version the override was written against. */
  version: number;
  component: ComponentType<never>;
}
