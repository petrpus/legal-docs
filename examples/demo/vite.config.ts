import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { z } from "zod";
// Type-only import (erased at runtime) — restores the compile-time net over the theme tokens the
// inline Custom block reads, so a future token rename is caught here too.
import type { Theme } from "../../dist/index";

// The library is consumed from its built output. Run `npm run build` in the repo root first.
const libUrl = new URL("../../dist/index.js", import.meta.url).href;
const catalogDir = fileURLToPath(new URL("../../legal-docs", import.meta.url));

/** Per-template server config: the code-side pieces a template needs (schema, derivations, custom blocks). */
interface TemplateConfig {
  schemas?: Record<string, z.ZodTypeAny>;
  derivations?: Record<string, (payload: unknown) => unknown>;
  customBlocks?: Record<string, unknown>;
  /** Variant family members (e.g. pledge-agreement two-party / three-party). */
  variants?: string[];
  /** A sample payload the client prefills into its JSON editor. */
  data?: unknown;
}
type Samples = Record<string, TemplateConfig>;

/**
 * A tiny dev-server API. PDF/DOCX/Catalog are Node-side, so rendering happens here (not in the
 * browser); the React client only sends template/variant/locale/theme/data and displays the returned
 * HTML or downloads the binary. This is the seam a real app would put behind its own server.
 */
function legalDocsApi(): Plugin {
  let lib: Awaited<ReturnType<typeof loadLib>> | undefined;
  let catalog: Awaited<ReturnType<typeof loadCatalog>> | undefined;
  let samples: Promise<Samples> | undefined;

  async function loadLib() {
    return import(/* @vite-ignore */ libUrl);
  }
  async function loadCatalog() {
    const l = (lib ??= await loadLib());
    return l.Catalog.fromDir(catalogDir);
  }
  function getSamples(l: Awaited<ReturnType<typeof loadLib>>): Promise<Samples> {
    return (samples ??= buildSamples(l));
  }

  return {
    name: "legal-docs-demo-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        try {
          const l = (lib ??= await loadLib());
          const cat = (catalog ??= await loadCatalog());
          const cfg = await getSamples(l);
          const url = (req.url ?? "").split("?")[0];

          if (req.method === "GET" && url === "/meta") {
            // Expose each template with its variants + a sample payload so the client can prefill.
            const templates = Object.keys(cfg).map((id) => ({
              id,
              ...(cfg[id]?.variants ? { variants: cfg[id]!.variants } : {}),
              ...(cfg[id]?.data !== undefined ? { data: cfg[id]!.data } : {}),
            }));
            return json(res, {
              templates,
              locales: ["en", "cs"],
              defaultTheme: l.defaultTheme,
              diff: { clause: "counterparts", from: 1, to: 2 },
            });
          }
          if (req.method === "POST" && url === "/render") {
            const body = await readBody(req);
            const { template, variant, locale, theme, format, data } = body as RenderBody;
            const c = cfg[template] ?? {};
            const result = await l.renderDocument({
              catalog: cat,
              template,
              ...(variant ? { variant } : {}),
              ...(locale ? { locale } : {}),
              data: data ?? {},
              // Omit a null/absent theme so renderDocument falls back to defaultTheme (a null would
              // override the default and crash; the UI always sends a full theme).
              ...(theme ? { theme } : {}),
              format,
              ...(c.schemas ? { schemas: c.schemas } : {}),
              ...(c.derivations ? { derivations: c.derivations } : {}),
              ...(c.customBlocks ? { customBlocks: c.customBlocks } : {}),
            });
            // Narrow on the discriminated result (not the local `format`) so this typechecks cleanly.
            if (result.format === "html") return json(res, { html: result.html });
            return json(res, { base64: result.buffer.toString("base64"), format: result.format });
          }
          if (req.method === "POST" && url === "/diff") {
            const { clause, from, to } = (await readBody(req)) as DiffBody;
            const diff = await cat.clauses.diff(clause, { from, to });
            return json(res, { html: l.renderClauseDiff(diff) });
          }
          next();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(res, { error: message }, 400);
        }
      });
    },
  };
}

/**
 * Builds the per-template server config. Schemas wrap the library's exported fragments (`party`,
 * `loan`) in this package's own zod — keep the two zod versions aligned so the instances stay
 * compatible. The signature-grid Custom block is defined inline (see `examples/signature-grid.tsx`
 * for the documented source) using the same react-pdf/docx instances the library loads.
 */
async function buildSamples(l: Awaited<ReturnType<typeof loadLib>>): Promise<Samples> {
  const { party, loan } = l as { party: z.ZodTypeAny; loan: z.ZodTypeAny };
  const signatureGrid = await buildSignatureGrid(l);
  const partySample = (name: string) => ({ name });
  return {
    hello: {},
    agreement: {},
    contract: {},
    localized: {},
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
        counterpartsCount: (p) => (p as { parties: unknown[] }).parties.length + 1,
        securityClause: (p) => ((p as { parties: unknown[] }).parties.length >= 3 ? "counterparts@v2" : "counterparts@v1"),
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
 * TWO IN SYNC (schema, escaping, borders, structure must match). This copy uses `createElement` (this
 * config file isn't JSX) and loads react/react-pdf/docx via dynamic import so they resolve to the same
 * instances the built library (`dist`) uses; that dedupe holds only while the demo's `react` /
 * `@react-pdf/renderer` / `docx` versions match the library's — keep them aligned (as with zod).
 */
async function buildSignatureGrid(l: Awaited<ReturnType<typeof loadLib>>) {
  const { createElement } = await import("react");
  const { Text, View } = await import("@react-pdf/renderer");
  const { BorderStyle, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const { escapeHtml, eighths, halfPoints, twips } = l as {
    escapeHtml: (s: string) => string;
    eighths: (n: number) => number;
    halfPoints: (n: number) => number;
    twips: (n: number) => number;
  };
  const schema = z.object({
    signatories: z.array(z.object({ name: z.string(), role: z.string().optional() })),
    columns: z.number().int().positive().optional(),
  });
  type Sig = { name: string; role?: string };

  return {
    schema,
    pdf: (props: unknown, ctx: { theme: Theme }) => {
      const { signatories, columns = 2 } = schema.parse(props);
      const theme = ctx.theme;
      const cellWidth = `${100 / columns}%`;
      return createElement(
        View,
        { style: { flexDirection: "row", flexWrap: "wrap" } },
        signatories.map((s: Sig, i: number) =>
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
    html: (props: unknown, ctx: { theme: Theme }) => {
      const { signatories, columns = 2 } = schema.parse(props);
      const theme = ctx.theme;
      const cellWidth = `${100 / columns}%`;
      const line = `border-top:${theme.signatures.lineWidth}px solid ${theme.signatures.lineColor};margin-top:${theme.signatures.lineSpace}px;margin-bottom:4px;`;
      const cells = signatories
        .map((s: Sig) => {
          const role =
            s.role !== undefined
              ? `<div style="font-size:${theme.signatures.fontSize}px;color:${theme.signatures.roleColor}">${escapeHtml(s.role)}</div>`
              : "";
          return `<div class="sig-cell" style="width:${cellWidth};padding-right:12px;margin-bottom:16px;box-sizing:border-box"><div class="sig-cell__line" style="${line}"></div><div>${escapeHtml(s.name)}</div>${role}</div>`;
        })
        .join("");
      return `<div class="sig-grid" style="display:flex;flex-wrap:wrap">${cells}</div>`;
    },
    docx: (props: unknown, ctx: { theme: Theme }) => {
      const { signatories, columns = 2 } = schema.parse(props);
      const theme = ctx.theme;
      const cell = (s: Sig) => {
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

interface RenderBody {
  template: string;
  variant?: string;
  locale?: string;
  theme: unknown;
  format: "pdf" | "html" | "docx";
  data?: unknown;
}
interface DiffBody {
  clause: string;
  from: number;
  to: number;
}

// Demo-only: reads the whole body as a string with no size limit / Content-Type check. Do not lift
// this into a real server without hardening (body limits, validation).
function readBody(req: Connect.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: { statusCode?: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default defineConfig({
  plugins: [react(), legalDocsApi()],
});
