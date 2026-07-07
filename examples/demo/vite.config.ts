import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createApiHandler } from "./server/api.mjs";

// The library is consumed from its built output. Run `npm run build` in the repo root first.
const libUrl = new URL("../../dist/index.js", import.meta.url).href;
const catalogDir = fileURLToPath(new URL("../../legal-docs", import.meta.url));

/**
 * Mounts the shared `/api/*` handler (`./server/api.mjs`) on the Vite dev server — the render/diff/
 * schema/editor logic itself lives there so the standalone deploy server (`server.mjs`) can reuse it
 * without duplication. This is the seam a real app would put behind its own server.
 */
function legalDocsApi(): Plugin {
  let handler: ReturnType<typeof createApiHandler> | undefined;

  async function getHandler() {
    if (!handler) {
      // Fails if `npm run build` hasn't produced dist/index.js yet — caught below, not left to crash
      // the dev server (Vite's own middleware try/catch only guards a *synchronous* throw, never a
      // rejected promise from an async middleware).
      const lib = await import(/* @vite-ignore */ libUrl);
      handler = createApiHandler({ lib, catalogDir });
    }
    return handler;
  }

  return {
    name: "legal-docs-demo-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        try {
          const { handle } = await getHandler();
          const pathname = (req.url ?? "").split("?")[0];
          const matched = await handle(pathname, req, res);
          if (!matched) next();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), legalDocsApi()],
});
