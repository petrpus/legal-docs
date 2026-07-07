#!/usr/bin/env node
// A deploy-ready standalone server for the demo: serves the built client (`vite build` output) and the
// same `/api/*` logic the dev server uses (`server/api.mjs`), so the demo stays fully interactive
// (render, theme editor, clause editor, diff) outside `vite dev`. No new dependencies (plain node:http).
//
// Prereqs: `npm run build` at the repo root, then `npm run build` in this directory (`vite build`).
// Run: node server.mjs   (PORT env var, default 8080)

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "./server/api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist");
const catalogDir = path.join(here, "..", "..", "legal-docs");
const libUrl = new URL("../../dist/index.js", import.meta.url).href;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(pathname, res) {
  // Resolve within `distDir` and reject any path that escapes it (traversal guard) before touching
  // the filesystem — `path.join` alone does not stop `..` segments from walking out of `distDir`.
  const requested = path.normalize(path.join(distDir, decodeURIComponent(pathname)));
  if (!requested.startsWith(distDir + path.sep) && requested !== distDir) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  const candidates = requested.endsWith(path.sep) || pathname === "/" ? [path.join(requested, "index.html")] : [requested];
  for (const file of candidates) {
    try {
      const st = await stat(file);
      if (st.isFile()) return sendFile(file, res);
    } catch {
      // fall through to the next candidate / the SPA fallback below
    }
  }
  // SPA fallback: any non-file, non-API path resolves to index.html (client-side routing has none
  // today, but this keeps a direct reload of a deep link working if that changes).
  return sendFile(path.join(distDir, "index.html"), res);
}

async function sendFile(file, res) {
  try {
    const body = await readFile(file);
    res.statusCode = 200;
    res.setHeader("Content-Type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

async function main() {
  const lib = await import(/* @vite-ignore */ libUrl);
  const { handle } = createApiHandler({ lib, catalogDir });
  const port = Number(process.env.PORT ?? 8080);

  const server = createServer(async (req, res) => {
    // A request handler on `createServer` is not awaited by Node, so a rejection here (a malformed
    // URI in `decodeURIComponent`, or anything else) becomes an *unhandled* promise rejection —
    // Node's default is to crash the whole process on that, taking down every other in-flight
    // request too. One bad request must never do that, so every path here is caught.
    try {
      const pathname = (req.url ?? "").split("?")[0];
      if (pathname.startsWith("/api/")) {
        const matched = await handle(pathname.slice("/api".length), req, res);
        if (!matched) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: `No such API route: ${pathname}` }));
        }
        return;
      }
      await serveStatic(pathname, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(port, () => {
    console.log(`legal-docs demo listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error("legal-docs demo failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
