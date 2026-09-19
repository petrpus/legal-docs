import { defineConfig } from "tsup";

/**
 * The editing subpath (`@petrpus/legal-docs/edit`) — built on its own, in a second `tsup` invocation
 * (see the `build` script), for two reasons:
 *
 * - Entries that share a build share code-split chunks, and the chunk the root entry pulls in carries
 *   `node:crypto` (Snapshot identity). Sharing it would silently make this browser-safe subpath
 *   unloadable in a browser — hence a browser platform target and a build of its own.
 * - The configs in `tsup.config.ts` run concurrently, and the library build cleans `dist/`. A separate
 *   invocation, sequenced by `&&`, is what guarantees this output is written *after* that clean rather
 *   than racing it.
 *
 * `tests/edit-browser-safety.test.ts` greps the emitted bundle for `node:` imports and editor libraries.
 */
export default defineConfig({
  entry: { edit: "src/edit/index.ts" },
  format: ["esm"],
  platform: "browser",
  target: "es2020",
  dts: { entry: { edit: "src/edit/index.ts" } },
  sourcemap: true,
  clean: false,
});
