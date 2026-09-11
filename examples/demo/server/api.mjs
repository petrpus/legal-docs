import { z } from "zod";

/** A fixed actor for the demo's edit audit (a real app would use the signed-in user). */
const DEMO_ACTOR = { id: "demo", name: "Demo Editor" };

/** Demo-only: caps the request body so a malformed/huge request can't exhaust server memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Framework-agnostic `/api/*` handler, shared by the Vite dev-server plugin (`vite.config.ts`) and the
 * deploy-ready standalone server (`server.mjs`) — each injects its own already-imported library module
 * (its own `dist/index.js`, or `src/index` under test), so this module has no import of its own on the
 * library and needs no build step to run.
 *
 * `handle(pathname, req, res)` resolves `true` if a route matched (it has already written the
 * response, success or error) or `false` if `pathname` isn't an API route the caller should fall
 * through on (static file serving / `next()`).
 */
export function createApiHandler({ lib, catalogDir }) {
  let catalog;
  let samples;
  // The editable catalog (in-memory reference store) backing the editor tab. Persists for the
  // process's lifetime; the node:sqlite adapter (adapters/sqlite/) is the persistent alternative.
  let editing;
  // Every Snapshot this process has issued, base and edited alike, keyed by id — the demo's stand-in
  // for the document store a real app would persist them in. An edited Snapshot never replaces its
  // base: both stay addressable, so `/edit/rerender` reproduces either side of an editing pass.
  const snapshots = new Map();

  async function getCatalog() {
    return (catalog ??= lib.Catalog.fromDir(catalogDir));
  }
  function getSamples() {
    return (samples ??= buildSamples(lib));
  }
  function getEditing() {
    if (!editing) {
      const store = new lib.MemoryEditableCatalogStore({
        clauses: [
          { clause: "welcome", version: 1, locale: "en", vars: {}, text: "Welcome to our service." },
          { clause: "welcome", version: 1, locale: "cs", vars: {}, text: "Vítejte v naší službě." },
          { clause: "notice", version: 1, locale: "en", vars: {}, text: "This notice applies to all users." },
        ],
        // A template consuming welcome@latest, so publishing runs the validate() gate against a real consumer.
        templates: [{ template: "letter", version: 1, locale: "en", body: [{ title: "LETTER" }, { clause: "welcome@latest" }] }],
      });
      editing = { store, cat: lib.Catalog.fromStore(store) };
    }
    return editing;
  }

  async function handle(pathname, req, res) {
    try {
      const cat = await getCatalog();
      const cfg = await getSamples();

      if (req.method === "GET" && pathname === "/meta") {
        // Expose each template with its variants + a sample payload so the client can prefill.
        const templates = Object.keys(cfg).map((id) => ({
          id,
          ...(cfg[id]?.variants ? { variants: cfg[id].variants } : {}),
          ...(cfg[id]?.data !== undefined ? { data: cfg[id].data } : {}),
        }));
        json(res, { templates, locales: ["en", "cs"], defaultTheme: lib.defaultTheme, diff: { clause: "counterparts", from: 1, to: 2 } });
        return true;
      }
      if (req.method === "POST" && pathname === "/render") {
        const body = await readBody(req);
        const { template, variant, locale, theme, format, data } = body;
        const c = cfg[template] ?? {};
        const result = await lib.renderDocument({
          catalog: cat,
          template,
          ...(variant ? { variant } : {}),
          ...(locale ? { locale } : {}),
          data: data ?? {},
          // Omit a null/absent theme so renderDocument falls back to defaultTheme (a null would
          // override the default and crash; the UI always sends a full theme).
          ...(theme ? { theme } : {}),
          format,
          ...codeSide(c),
        });
        // Narrow on the discriminated result (not the local `format`) so this stays correct.
        if (result.format === "html") json(res, { html: result.html });
        else json(res, { base64: result.buffer.toString("base64"), format: result.format });
        return true;
      }
      if (req.method === "POST" && pathname === "/diff") {
        const { clause, from, to } = await readBody(req);
        const diff = await cat.clauses.diff(clause, { from, to });
        json(res, { html: lib.renderClauseDiff(diff) });
        return true;
      }
      if (req.method === "POST" && pathname === "/schema") {
        // Export the selected template's payload schema(s) to JSON Schema (Wave 4 #1).
        const { template } = await readBody(req);
        const schemas = cfg[template]?.schemas ?? {};
        json(res, { schemas: lib.exportPayloadSchemas(schemas) });
        return true;
      }

      // --- Edit before export (PRD #147 / ADR-0014): freeze → edit → export → re-render ---
      if (pathname.startsWith("/edit/")) {
        const b = await readBody(req);
        if (pathname === "/edit/start") {
          // `full` mode freezes the tree the browser will edit *and* the inputs it was assembled from,
          // so the edited Snapshot's provenance survives the editing pass (ADR-0003 / ADR-0014).
          const generated = await lib.renderDocument({
            catalog: cat,
            template: b.template,
            ...(b.variant ? { variant: b.variant } : {}),
            ...(b.locale ? { locale: b.locale } : {}),
            data: b.data ?? {},
            format: "html",
            snapshotMode: "full",
            ...codeSide(cfg[b.template]),
          });
          snapshots.set(generated.snapshot.id, generated.snapshot);
          json(res, { baseId: generated.snapshot.id, tree: generated.snapshot.tree, html: generated.html });
          return true;
        }
        if (pathname === "/edit/export") {
          const snapshot = requireSnapshot(snapshots, b.baseId);
          // Guard the Edit set as it crosses the wire, so a malformed op answers with its zod issues
          // (naming `ops/<index>`) instead of failing obscurely inside the builder.
          lib.assertValidEditSet(b.edits);
          const out = await lib.renderEdited({
            snapshot,
            edits: b.edits,
            format: b.format ?? "html",
            ...customBlocksOf(cfg[snapshot.template]),
          });
          // The edited Snapshot is stored NEXT TO its base, never over it — both stay re-renderable.
          snapshots.set(out.snapshot.id, out.snapshot);
          if (b.review === true) {
            // The compare document is a SECOND rendering of the same frozen edit, never a shortcut
            // around it: the edited Snapshot above is what proves the two trees below belong together.
            if (out.format !== "docx") throw new Error(`A review export is a Word compare document — ask for format "docx", not "${out.format}".`);
            const buffer = await lib.renderRedlineToDocx(lib.buildRedline(snapshot.tree, out.snapshot.tree), {
              ...customBlocksOf(cfg[snapshot.template]),
              ...(b.edits.author ? { author: b.edits.author } : {}),
              ...(b.edits.at ? { date: b.edits.at } : {}),
              ...(b.edits.comments ? { comments: b.edits.comments } : {}),
            });
            json(res, { baseId: snapshot.id, editedId: out.snapshot.id, format: "docx", review: true, base64: buffer.toString("base64") });
            return true;
          }
          json(res, { baseId: snapshot.id, editedId: out.snapshot.id, ...rendered(out) });
          return true;
        }
        if (pathname === "/edit/rerender") {
          const snapshot = requireSnapshot(snapshots, b.id);
          const out = await lib.renderFromSnapshot(snapshot, {
            format: b.format ?? "html",
            ...customBlocksOf(cfg[snapshot.template]),
          });
          json(res, { id: snapshot.id, ...rendered(out) });
          return true;
        }
      }

      // --- Editor (ADR-0009 runtime editing API over an in-memory editable store) ---
      if (pathname.startsWith("/editing")) {
        const e = getEditing();
        if (req.method === "GET" && pathname === "/editing/state") {
          json(res, await editingState(e));
          return true;
        }
        const b = await readBody(req);
        const draft = { ref: { kind: "clause", id: b.id }, version: b.version };
        if (pathname === "/editing/create") {
          const h = await e.cat.editing.createDraft({ ref: draft.ref, content: clauseContent(b), actor: DEMO_ACTOR });
          json(res, { draft: summary(h) });
          return true;
        }
        if (pathname === "/editing/update") {
          const h = await e.cat.editing.updateDraft({ draft, content: clauseContent(b), actor: DEMO_ACTOR });
          json(res, { draft: summary(h) });
          return true;
        }
        if (pathname === "/editing/submit") {
          json(res, { draft: summary(await e.cat.editing.submitForReview(draft, DEMO_ACTOR)) });
          return true;
        }
        if (pathname === "/editing/withdraw") {
          json(res, { draft: summary(await e.cat.editing.withdraw(draft, DEMO_ACTOR)) });
          return true;
        }
        if (pathname === "/editing/delete") {
          await e.cat.editing.deleteDraft(draft, DEMO_ACTOR);
          json(res, { ok: true });
          return true;
        }
        if (pathname === "/editing/publish") {
          try {
            const published = await e.cat.editing.publish(draft, DEMO_ACTOR);
            json(res, { ok: true, published });
          } catch (err) {
            // A blocked publish is a normal result (findings), not a server error.
            if (err instanceof lib.PublishValidationError) json(res, { ok: false, findings: err.findings });
            else throw err;
          }
          return true;
        }
        if (pathname === "/editing/diff") {
          const diff = await e.cat.editing.previewDiff(draft, { locale: b.locale });
          json(res, { html: lib.renderClauseDiff(diff) });
          return true;
        }
      }

      return false;
    } catch (error) {
      json(res, errorBody(lib, error), 400);
      return true;
    }
  }

  return { handle };
}

/**
 * The 400 body. A rejected edit carries structure worth forwarding: an `EditError` names the op index,
 * the tree path and a machine-readable reason, and an `EditSetValidationError` carries the zod issues —
 * both let the client point at the offending field instead of showing a sentence.
 */
function errorBody(lib, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof lib.EditError) {
    return { error: message, reason: error.reason, path: lib.formatTreePath(error.path), ...(error.opIndex !== undefined ? { opIndex: error.opIndex } : {}) };
  }
  if (error instanceof lib.EditSetValidationError) return { error: message, issues: error.issues };
  return { error: message };
}

/** The code-side pieces a template needs at assembly time, keyed by template in {@link buildSamples}. */
function codeSide(c = {}) {
  return {
    ...(c.schemas ? { schemas: c.schemas } : {}),
    ...(c.derivations ? { derivations: c.derivations } : {}),
    ...customBlocksOf(c),
  };
}

/**
 * A Custom block's implementation is code, not frozen data (ADR-0005), so it must be re-supplied to
 * every render of a stored Snapshot — editing never changes that.
 */
function customBlocksOf(c = {}) {
  return c.customBlocks ? { customBlocks: c.customBlocks } : {};
}

/** Look up a stored Snapshot, failing with a message that names the id the client asked for. */
function requireSnapshot(snapshots, id) {
  const snapshot = snapshots.get(id);
  if (!snapshot) throw new Error(`Unknown Snapshot id "${id}" — start an editing pass first (the demo stores Snapshots in memory only).`);
  return snapshot;
}

/** A render result as JSON: HTML inline, a binary format base64-encoded. */
function rendered(out) {
  return out.format === "html" ? { format: "html", html: out.html } : { format: out.format, base64: out.buffer.toString("base64") };
}

/**
 * Builds the per-template server config. Schemas wrap the library's exported fragments (`party`,
 * `loan`) in this package's own zod — keep the two zod versions aligned so the instances stay
 * compatible. The signature-grid Custom block is defined inline (see `examples/signature-grid.tsx`
 * for the documented source) using the same react-pdf/docx instances the library loads.
 */
async function buildSamples(lib) {
  const { party, loan } = lib;
  const signatureGrid = await buildSignatureGrid(lib);
  const partySample = (name) => ({ name });
  return {
    hello: {},
    agreement: {},
    contract: {},
    localized: {},
    styled: {}, // showcase: per-block alignment + indentation (ADR-0008)
    "nda-headed": {
      // showcase: page header/footer + numbering (ADR-0011) and locale-aware helpers (ADR-0010).
      schemas: { "nda@1": z.object({ party, amount: z.number(), currency: z.string(), date: z.string() }) },
      data: { party: { name: "Acme Bank a.s." }, amount: 50000, currency: "EUR", date: "2026-07-06" },
    },
    greeting: {
      schemas: { "greeting@1": z.object({ name: z.string(), loan }) },
      data: { name: "Alice", loan: { principal: { amount: 1000, currency: "EUR" } } },
    },
    parties: {
      schemas: { "parties@1": z.object({ lender: party, borrower: party, loan }) },
      data: {
        lender: { name: "Acme Bank a.s." },
        borrower: { name: "Jane Doe" },
        loan: { principal: { amount: 250000, currency: "EUR" }, rate: 4.5 },
      },
    },
    signoff: {
      schemas: { "signoff@1": z.object({ lender: party, witness: z.string() }) },
      data: { lender: { name: "Acme Bank a.s." }, witness: "John Watson" },
    },
    terms: {
      // for/if control flow + code-side derivations that pick a Clause version by party count.
      schemas: {
        "terms@1": z.object({
          parties: z.array(z.object({ name: z.string(), role: z.string() })),
          hasGuarantor: z.boolean(),
        }),
      },
      derivations: {
        counterpartsCount: (p) => p.parties.length + 1,
        securityClause: (p) => (p.parties.length >= 3 ? "counterparts@v2" : "counterparts@v1"),
      },
      data: {
        parties: [
          { name: "Alpha Ltd", role: "Lender" },
          { name: "Beta GmbH", role: "Pledgor" },
          { name: "Gamma s.r.o.", role: "Accession" },
        ],
        hasGuarantor: true,
      },
    },
    "pledge-agreement": {
      // A Variant family: the member swaps the `security` slot Clause (v1 for two-party, v2 for three).
      schemas: { "pledge@1": z.object({ parties: z.array(party) }) },
      variants: ["two-party", "three-party"],
      data: { parties: [partySample("Acme Bank a.s."), partySample("Jane Doe"), partySample("Guarantor Ltd")] },
    },
    "signature-grid": {
      // A Custom block (escape hatch) — a multi-column signature grid the core `signatures` node can't express.
      customBlocks: { "signature-grid": signatureGrid },
      data: {
        signatories: [
          { name: "Acme Bank a.s.", role: "Lender" },
          { name: "Jane Doe", role: "Borrower" },
          { name: "Guarantor Ltd", role: "Guarantor" },
        ],
      },
    },
  };
}

/**
 * The example signature-grid Custom block, inlined. Mirrors `examples/signature-grid.tsx` — KEEP THE
 * TWO IN SYNC (schema, escaping, borders, structure must match). Loads react/react-pdf/docx via dynamic
 * import so they resolve to the same instances the built library uses; that dedupe holds only while the
 * demo's `react` / `@react-pdf/renderer` / `docx` versions match the library's — keep them aligned (as
 * with zod).
 */
async function buildSignatureGrid(lib) {
  const { createElement } = await import("react");
  const { Text, View } = await import("@react-pdf/renderer");
  const { BorderStyle, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const { escapeHtml, eighths, halfPoints, twips } = lib;
  const schema = z.object({
    signatories: z.array(z.object({ name: z.string(), role: z.string().optional() })),
    columns: z.number().int().positive().optional(),
  });

  return {
    schema,
    pdf: (props, ctx) => {
      const { signatories, columns = 2 } = schema.parse(props);
      const theme = ctx.theme;
      const cellWidth = `${100 / columns}%`;
      return createElement(
        View,
        { style: { flexDirection: "row", flexWrap: "wrap" } },
        signatories.map((s, i) =>
          createElement(
            View,
            { key: i, style: { width: cellWidth, paddingRight: 12, marginBottom: 16 } },
            createElement(View, { style: { marginTop: 28, borderTopWidth: 1, borderColor: theme.color.text, marginBottom: 4 } }),
            createElement(Text, { style: { fontSize: theme.fontSize.paragraph } }, s.name),
            s.role !== undefined
              ? createElement(Text, { style: { fontSize: theme.signatures.fontSize, color: theme.signatures.roleColor } }, s.role)
              : null,
          ),
        ),
      );
    },
    html: (props, ctx) => {
      const { signatories, columns = 2 } = schema.parse(props);
      const theme = ctx.theme;
      const cellWidth = `${100 / columns}%`;
      const line = `border-top:${theme.signatures.lineWidth}px solid ${theme.signatures.lineColor};margin-top:${theme.signatures.lineSpace}px;margin-bottom:4px;`;
      const cells = signatories
        .map((s) => {
          const role =
            s.role !== undefined
              ? `<div style="font-size:${theme.signatures.fontSize}px;color:${theme.signatures.roleColor}">${escapeHtml(s.role)}</div>`
              : "";
          return `<div class="sig-cell" style="width:${cellWidth};padding-right:12px;margin-bottom:16px;box-sizing:border-box"><div class="sig-cell__line" style="${line}"></div><div>${escapeHtml(s.name)}</div>${role}</div>`;
        })
        .join("");
      return `<div class="sig-grid" style="display:flex;flex-wrap:wrap">${cells}</div>`;
    },
    docx: (props, ctx) => {
      const { signatories, columns = 2 } = schema.parse(props);
      const theme = ctx.theme;
      const cell = (s) => {
        const children = [
          new Paragraph({
            border: { top: { style: BorderStyle.SINGLE, size: eighths(theme.signatures.lineWidth), color: theme.signatures.lineColor.replace(/^#/, "") } },
            spacing: { before: twips(theme.signatures.lineSpace) },
          }),
          new Paragraph({ children: [new TextRun({ text: s.name, size: halfPoints(theme.signatures.fontSize) })] }),
        ];
        if (s.role !== undefined) {
          children.push(new Paragraph({ children: [new TextRun({ text: s.role, size: halfPoints(theme.signatures.fontSize), color: theme.signatures.roleColor.replace(/^#/, "") })] }));
        }
        return new TableCell({ children });
      };
      const rows = [];
      for (let i = 0; i < signatories.length; i += columns) {
        rows.push(new TableRow({ children: signatories.slice(i, i + columns).map(cell) }));
      }
      const none = { style: BorderStyle.NONE, size: 0, color: "auto" };
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
          rows,
        }),
      ];
    },
  };
}

function clauseContent(b) {
  return { kind: "clause", clause: { clause: b.id, version: b.version ?? 0, locale: b.locale, vars: {}, text: b.text ?? "" } };
}
function summary(h) {
  return { id: h.draft.ref.id, version: h.draft.version, status: h.status, locales: h.content.map((c) => c.clause.locale) };
}
async function editingState(e) {
  const clauses = [];
  for (const id of await e.store.clauseIds()) {
    const versions = await e.store.clauseVersions(id);
    const latest = versions.at(-1);
    const c = latest !== undefined ? await e.store.loadClause(id, latest, "en").catch(() => undefined) : undefined;
    clauses.push({ id, versions, latestVersion: latest ?? null, latestText: c?.text ?? null });
  }
  const drafts = (await e.cat.editing.listDrafts()).map(summary);
  const audit = await e.cat.editing.auditLog();
  return { clauses, drafts, audit, actor: DEMO_ACTOR };
}

/**
 * Reads the request body as JSON, capped at {@link MAX_BODY_BYTES}. Demo-only otherwise (no
 * Content-Type check) — this is the one piece of hardening carried over from the original dev-only
 * plugin's TODO, since a deploy-ready server is reachable by more than a trusted local browser.
 *
 * Deliberately does NOT `req.destroy()` on overflow: destroying the socket here would prevent the
 * caller's error response (the 400 JSON `handle()` writes on catching this rejection) from ever
 * reaching the client. Once over the limit, further chunks are just not appended (`raw` stops
 * growing) — a `settled` guard stops a duplicate reject/resolve once the limit trips.
 */
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = "";
    let bytes = 0;
    let overLimit = false;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (overLimit) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        overLimit = true;
        fail(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      try {
        settled = true;
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

function json(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
