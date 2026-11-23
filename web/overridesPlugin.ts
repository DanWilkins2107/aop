import type { Plugin } from "vite";

const ID = "virtual:aop-overrides";
const RESOLVED = `\0${ID}`;

/** Serves the extensions' component overrides to `web/src/extendable`. None yet. */
export function overridesPlugin(): Plugin {
  return {
    name: "aop-overrides",
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load: (id) => (id === RESOLVED ? "export default [];" : undefined),
  };
}
