import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The demo imports the library through its published specifiers. Under `verify` the tests run
    // BEFORE `npm run build`, so — exactly as `tests/demo-api.test.ts` injects `src` into the demo
    // server — they resolve to the sources here, not to `dist/`. The array form (not the object one)
    // keeps the two entries apart: a bare `@petrpus/legal-docs` key would also swallow its subpaths.
    alias: [
      { find: "@petrpus/legal-docs/edit", replacement: fileURLToPath(new URL("./src/edit/index.ts", import.meta.url)) },
      { find: /^@petrpus\/legal-docs$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    // The demo's editor mapping (`examples/demo/src/editor/`) is proved by a fast-check property that
    // belongs to the root gate; its `prosemirror-model` / `fast-check` devDependencies stay in the
    // demo (CI installs them alongside the root ones — see `.github/workflows/ci.yml`).
    include: ["tests/**/*.test.ts", "examples/demo/src/**/*.test.ts"],
  },
});
