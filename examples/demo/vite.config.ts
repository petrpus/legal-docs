import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { z } from "zod";

// The library is consumed from its built output. Run `npm run build` in the repo root first.
const libUrl = new URL("../../dist/index.js", import.meta.url).href;
const catalogDir = fileURLToPath(new URL("../../legal-docs", import.meta.url));

/**
 * A tiny dev-server API. PDF/DOCX/Catalog are Node-side, so rendering happens here (not in the
 * browser); the React client only sends theme/locale/data and displays the returned HTML or
 * downloads the binary. This is the seam a real app would put behind its own server.
 */
function legalDocsApi(): Plugin {
  let lib: Awaited<ReturnType<typeof loadLib>> | undefined;
  let catalog: Awaited<ReturnType<typeof loadCatalog>> | undefined;

  async function loadLib() {
    return import(/* @vite-ignore */ libUrl);
  }
  async function loadCatalog() {
    const l = (lib ??= await loadLib());
    return l.Catalog.fromDir(catalogDir);
  }
  function configFor(l: { loan: z.ZodTypeAny }, template: string): { schemas?: unknown } {
    // Templates that need a typed payload declare their schema here (others bind raw/empty data).
    // Note: `z` here is the demo's own zod instance wrapping the library's `loan` fragment — keep this
    // package's zod version aligned with the library's so the two instances stay compatible.
    if (template === "greeting") {
      return { schemas: { "greeting@1": z.object({ name: z.string(), loan: l.loan }) } };
    }
    return {};
  }

  return {
    name: "legal-docs-demo-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        try {
          const l = (lib ??= await loadLib());
          const cat = (catalog ??= await loadCatalog());
          const url = (req.url ?? "").split("?")[0];

          if (req.method === "GET" && url === "/meta") {
            return json(res, {
              templates: ["hello", "agreement", "contract", "greeting", "localized"],
              locales: ["en", "cs"],
              defaultTheme: l.defaultTheme,
              diff: { clause: "counterparts", from: 1, to: 2 },
              dataTemplates: { greeting: { name: "Alice", loan: { principal: { amount: 1000, currency: "EUR" } } } },
            });
          }
          if (req.method === "POST" && url === "/render") {
            const body = await readBody(req);
            const { template, locale, theme, format, data } = body as RenderBody;
            const result = await l.renderDocument({
              catalog: cat,
              template,
              ...(locale ? { locale } : {}),
              data: data ?? {},
              // Omit a null/absent theme so renderDocument falls back to defaultTheme (a null would
              // override the default and crash; the UI always sends a full theme).
              ...(theme ? { theme } : {}),
              format,
              ...configFor(l, template),
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

interface RenderBody {
  template: string;
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
