import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries sharing one build: the public library (`index`, with declarations) and the CLI bin
  // (`cli`, no public type surface). esbuild code-splits shared modules into a common chunk.
  entry: { index: "src/index.ts", cli: "src/cli/bin.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  target: "node20",
});
