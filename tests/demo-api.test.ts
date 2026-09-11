import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";
import { createApiHandler } from "../examples/demo/server/api.mjs";
import * as lib from "../src/index";
import { EDIT_SET_SCHEMA_VERSION, type EditSet } from "../src/core/edit";

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

const ORIGINAL_TITLE = "DECLARATION AND CONFIRMATION";
const EDITED_TITLE = "AMENDED DECLARATION";

/**
 * The "Edit before export" flow (#157): `/edit/start` freezes a base Snapshot server-side, the browser
 * builds an Edit set against its tree, and `/edit/export` turns that into an edited Snapshot + output.
 * Both Snapshots stay stored, so `/edit/rerender` reproduces either one.
 */
describe("demo edit API (/api/edit/*)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    ({ server, base } = await startServer());
  });

  afterAll(() => {
    server.close();
  });

  async function start() {
    const body = await postJson(base, "/edit/start", { template: "hello" });
    expect(body.error).toBeUndefined();
    return body as { baseId: string; tree: lib.DocumentTree; html: string };
  }

  function editSet(baseId: string, ops: EditSet["ops"]): EditSet {
    return { schemaVersion: EDIT_SET_SCHEMA_VERSION, baseSnapshotId: baseId, ops, author: "demo", at: "2026-09-11T10:00:00.000Z" };
  }

  const retitle: EditSet["ops"] = [{ op: "setText", path: ["body", 0, "text"], value: EDITED_TITLE }];

  it("starts an editing pass: a stored base Snapshot, its frozen tree and the base HTML", async () => {
    const started = await start();

    expect(started.baseId).toMatch(/^[0-9a-f]{16}$/);
    expect(started.tree.body[0]).toMatchObject({ kind: "title", text: ORIGINAL_TITLE });
    expect(started.html).toContain(ORIGINAL_TITLE);
  });

  it("exports an Edit set as an edited Snapshot whose re-render is byte-identical", async () => {
    const started = await start();

    const exported = await postJson(base, "/edit/export", {
      baseId: started.baseId,
      edits: editSet(started.baseId, retitle),
      format: "html",
    });
    expect(exported.error).toBeUndefined();
    expect(exported.baseId).toBe(started.baseId);
    expect(exported.editedId).not.toBe(started.baseId);
    expect(exported.html).toContain(EDITED_TITLE);
    expect(exported.html).not.toContain(ORIGINAL_TITLE);

    // The exported document is the edited Snapshot's rendering — not a second, parallel render path.
    const again = await postJson(base, "/edit/rerender", { id: exported.editedId, format: "html" });
    expect(again.html).toBe(exported.html);
  });

  it("exports what a browser session produces: start → ops → Edit set → edited Snapshot", async () => {
    const started = await start();

    // What the Edit tab does client-side, minus the DOM: the session owns the ops and the views, and
    // the only thing that crosses back to the server is the Edit set it exports.
    const session = lib.createEditSession({ base: { id: started.baseId, tree: started.tree }, author: "Demo Editor" });
    expect(session.apply({ op: "setText", path: ["body", 0, "text"], value: EDITED_TITLE }).ok).toBe(true);
    expect(session.apply({ op: "insertNode", path: ["body", 2], node: { kind: "paragraph", text: "Added by hand." } }).ok).toBe(true);
    session.addComment({ path: ["body", 0], text: "Retitled on the client." });
    expect(session.redlineHtml()).toContain("<ins");

    const exported = await postJson(base, "/edit/export", { baseId: started.baseId, edits: session.toEditSet(), format: "html" });

    expect(exported.html).toContain(EDITED_TITLE);
    expect(exported.html).toContain("Added by hand.");
    // The review view is not an export path — a comment can never reach a rendered document.
    expect(exported.html).not.toContain("Retitled on the client.");
    const again = await postJson(base, "/edit/rerender", { id: exported.editedId, format: "html" });
    expect(again.html).toBe(exported.html);
  });

  it("keeps the base Snapshot stored, re-rendering the original document", async () => {
    const started = await start();
    await postJson(base, "/edit/export", { baseId: started.baseId, edits: editSet(started.baseId, retitle), format: "html" });

    const original = await postJson(base, "/edit/rerender", { id: started.baseId, format: "html" });

    expect(original.html).toBe(started.html);
    expect(original.html).toContain(ORIGINAL_TITLE);
  });

  it("carries the edit into the PDF and DOCX exports", async () => {
    const started = await start();
    const edits = editSet(started.baseId, retitle);

    const pdf = await postJson(base, "/edit/export", { baseId: started.baseId, edits, format: "pdf" });
    const parser = new PDFParse({ data: Buffer.from(pdf.base64, "base64") });
    try {
      expect((await parser.getText()).text).toContain(EDITED_TITLE);
    } finally {
      await parser.destroy();
    }

    const docx = await postJson(base, "/edit/export", { baseId: started.baseId, edits, format: "docx" });
    const zip = await JSZip.loadAsync(Buffer.from(docx.base64, "base64"));
    expect(await zip.file("word/document.xml")!.async("string")).toContain(EDITED_TITLE);
  });

  it("rejects an unknown base Snapshot id with a 400 naming it", async () => {
    const res = await fetch(`${base}/edit/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseId: "0000000000000000", edits: editSet("0000000000000000", retitle), format: "html" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("0000000000000000");
  });

  it("rejects an op that does not apply with a 400 naming the op index", async () => {
    const started = await start();
    const edits = editSet(started.baseId, [...retitle, { op: "setText", path: ["body", 99, "text"], value: "nowhere" }]);

    const res = await fetch(`${base}/edit/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseId: started.baseId, edits, format: "html" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.opIndex).toBe(1);
    expect(body.error).toMatch(/op 1 \(setText\)/);
    expect(body.path).toBe("/body/99/text");
  });

  it("rejects a malformed op with a 400 whose issues name the op", async () => {
    const started = await start();
    const edits = { ...editSet(started.baseId, []), ops: [{ op: "setText", path: ["body", 0, "text"] }] };

    const res = await fetch(`${base}/edit/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseId: started.baseId, edits, format: "html" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path.slice(0, 2)).toEqual(["ops", 0]);
  });

  it("rejects a re-render of an unknown Snapshot id", async () => {
    const res = await fetch(`${base}/edit/rerender`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ffffffffffffffff", format: "html" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ffffffffffffffff");
  });
});
