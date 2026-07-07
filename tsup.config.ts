import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Two entries sharing one build: the public library (`index`, with declarations) and the CLI bin
    // (`cli`, no public type surface). esbuild code-splits shared modules into a common chunk.
    entry: { index: "src/index.ts", cli: "src/cli/bin.ts" },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts" } },
    clean: true,
    sourcemap: true,
    target: "node20",
  },
  {
    // The browser-safe subset (src/browser.ts — no node:fs/node:crypto/node:stream, no react-pdf/docx),
    // bundled standalone into the static doc site's assets for the live in-browser demo (docs/live-demo.html).
    // Fully self-contained (noExternal: bundle zod/jsep too) since a static site can't resolve bare imports.
    entry: { "browser-demo": "src/browser.ts" },
    format: ["esm"],
    platform: "browser",
    target: "es2020",
    outDir: "docs/assets",
    noExternal: [/.*/],
    dts: false,
    sourcemap: false,
    minify: true,
    clean: false,
  },
]);
