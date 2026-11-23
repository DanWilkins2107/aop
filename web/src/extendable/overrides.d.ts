// The build serves this module with every extension's overrides, in config order.
declare module "virtual:aop-overrides" {
  import type { OverrideLayer } from "./types.js";

  const layers: readonly OverrideLayer[];
  export default layers;
}
