import { createElement, type ComponentType } from "react";
import type { OverrideLayer } from "./types.js";

/**
 * Stacks the layers for `id` on `Base`, bottom to top, each one's `Original` being the layer
 * below. Each layer is made once, so the result keeps one identity for the page's life.
 */
export function stackOverrides<P extends object>(
  id: string,
  version: number,
  Base: ComponentType<P>,
  layers: readonly OverrideLayer[],
): ComponentType<P> {
  let below = Base;
  for (const layer of layers) {
    if (layer.id !== id) continue;
    if (layer.version !== version) {
      console.warn(`${layer.extension} overrides ${id} v${layer.version}, but AOP's ${id} is v${version}.`);
    }
    below = layered(id, layer, below);
  }
  return below;
}

function layered<P extends object>(id: string, layer: OverrideLayer, Original: ComponentType<P>): ComponentType<P> {
  const Override = layer.component as ComponentType<P & { Original: ComponentType<P> }>;
  function Layer(props: P) {
    return createElement(Override, { ...props, Original });
  }
  Layer.displayName = `${id} (${layer.extension})`;
  return Layer;
}
