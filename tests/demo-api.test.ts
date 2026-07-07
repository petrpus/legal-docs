import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApiHandler } from "../examples/demo/server/api.mjs";
import * as lib from "../src/index";

const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "legal-docs");

/**
 * Spins a throwaway `node:http` server around the shared `/api/*` handler, injecting the **src**
 * library (not `dist`) — this is what makes the handler testable pre-build, since `verify` runs tests
 * before `npm run build`. `vite.config.ts` and `server.mjs` each inject their own `dist/index.js`.
 */
function startServer(): Promise<{ server: Server; base: string }> {
  const { handle } = createApiHandler({ lib, catalogDir });
  const server = createServer(async (req, res) => {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    const matched = await handle(pathname.replace(/^\/api/, ""), req, res);
    if (!matched) {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// `fetch(...).json()` returns `Promise<any>` (from lib.dom) — matched implicitly here rather than
// annotated, since an explicit `any` type is banned by lint but the implicit inference isn't.
async function postJson(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe("demo API handler (examples/demo/server/api.mjs)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    ({ server, base } = await startServer());
  });

  afterAll(() => {
    server.close();
  });

  it("GET /meta lists templates including nda-headed, and the default theme", async () => {
    const res = await fetch(`${base}/meta`);
    const body = await res.json();
    expect(body.templates.map((t: { id: string }) => t.id)).toContain("nda-headed");
    expect(body.defaultTheme).toBeDefined();
    expect(body.locales).toEqual(["en", "cs"]);
  });

  it("POST /render (html) renders a schema-less template", async () => {
    const body = await postJson(base, "/render", { template: "hello", format: "html", data: {} });
    expect(body.html).toContain('<div class="legal-doc">');
  });

  it("POST /render (pdf) returns a base64-encoded PDF", async () => {
    const body = await postJson(base, "/render", { template: "hello", format: "pdf", data: {} });
    expect(body.format).toBe("pdf");
    expect(Buffer.from(body.base64, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("POST /schema exports the requested template's payload JSON Schema", async () => {
    const body = await postJson(base, "/schema", { template: "greeting" });
    expect(body.schemas["greeting@1"].$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("returns a 400 JSON error (not a crash) for an unknown template", async () => {
    const res = await fetch(`${base}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "does-not-exist", format: "html", data: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns false→404 for a path outside the handler's routes", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("diffs two clause versions", async () => {
    const body = await postJson(base, "/diff", { clause: "counterparts", from: 1, to: 2 });
    expect(typeof body.html).toBe("string");
    expect(body.html.length).toBeGreaterThan(0);
  });

  it("rejects an over-limit request body with a clean 400 (not a hung/reset connection)", async () => {
    // Regression: the body-size guard must reject *and* still let the client receive the response —
    // an earlier version called req.destroy() on overflow, which severed the socket before the 400
    // JSON could be written.
    const oversized = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(`${base}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "hello", format: "html", data: { note: oversized } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds/);
  });

  it("supports a full editing round-trip: create → submit → publish → GET state", async () => {
    const created = await postJson(base, "/editing/create", { id: "welcome", locale: "en", text: "Hi." });
    const { version } = created.draft;
    await postJson(base, "/editing/submit", { id: "welcome", version, locale: "en" });
    const published = await postJson(base, "/editing/publish", { id: "welcome", version, locale: "en" });
    expect(published.ok).toBe(true);

    const state = await fetch(`${base}/editing/state`).then((r) => r.json());
    const welcome = state.clauses.find((c: { id: string }) => c.id === "welcome");
    expect(welcome.latestVersion).toBe(version);
  });
});
