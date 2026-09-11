import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { applyEdits, createEditSession, renderTreeToHtml, type DocumentTree } from "../src/browser";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const editEntry = path.join(srcDir, "core", "edit", "index.ts");
const sessionEntry = path.join(srcDir, "edit", "index.ts");

/** Every `from "…"` / `import "…"` specifier in a TypeScript source file. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]!);
}

/** The file a resolved relative specifier means: `./x` is `x.ts`, or the `x/index.ts` barrel. */
function resolveModule(resolved: string): string {
  if (resolved.endsWith(".ts")) return resolved;
  return existsSync(`${resolved}.ts`) ? `${resolved}.ts` : path.join(resolved, "index.ts");
}

/**
 * The module graph reachable from `entry`, following relative imports only. Bare specifiers are
 * returned as-is so the caller can police the dependency surface.
 */
function reachable(entry: string): { files: string[]; bare: string[] } {
  const files: string[] = [];
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith(".")) {
        bare.add(specifier);
        continue;
      }
      queue.push(resolveModule(path.resolve(path.dirname(file), specifier)));
    }
  }
  return { files, bare: [...bare].sort() };
}

/**
 * The editing layer runs client-side (ADR-0012): a browser applies ops and previews HTML, while only
 * identity (`node:crypto`) and the PDF/DOCX renderers stay on the server. A static scan of the whole
 * module graph reachable from `src/core/edit` is what keeps that true — an accidental `import` of the
 * Snapshot module or of `docx` two hops down would not fail any behavioural test.
 */
describe("the edit modules stay browser-safe", () => {
  it("imports no Node built-in, transitively", () => {
    const { files } = reachable(editEntry);
    const offenders = files.filter((file) => importsOf(file).some((specifier) => specifier.startsWith("node:")));
    expect(offenders.map((file) => path.relative(srcDir, file))).toEqual([]);
  });

  it("depends on no package other than zod, transitively", () => {
    expect(reachable(editEntry).bare).toEqual(["zod"]);
  });

  it("pulls in a small, deliberate slice of core", () => {
    const { files } = reachable(editEntry);
    expect(files.length).toBeGreaterThan(1);
    // Sanity: the scan really followed relative imports out of the edit directory.
    expect(files.map((file) => path.relative(srcDir, file))).toContain(path.join("core", "document-tree-schema.ts"));
  });
});

/**
 * The same scan, pointed at the published `@petrpus/legal-docs/edit` subpath. It reaches further than
 * `src/core/edit` — the session previews HTML — so the dependency surface is wider, but the rule that
 * matters is unchanged: nothing a browser loads may import a Node built-in.
 */
describe("the edit subpath stays browser-safe", () => {
  it("imports no Node built-in, transitively", () => {
    const { files } = reachable(sessionEntry);
    const offenders = files.filter((file) => importsOf(file).some((specifier) => specifier.startsWith("node:")));
    expect(offenders.map((file) => path.relative(srcDir, file))).toEqual([]);
  });

  it("depends on no package beyond zod and two type-only renderer imports", () => {
    // `react` and `docx` are `import type` in `src/custom-block.ts` (the per-format Custom block
    // signatures) — erased at build time, which the built-bundle check below proves.
    expect(reachable(sessionEntry).bare).toEqual(["docx", "react", "zod"]);
  });

  it("pulls the HTML renderer in, since the session previews", () => {
    const files = reachable(sessionEntry).files.map((file) => path.relative(srcDir, file));
    expect(files).toContain(path.join("render-html", "render-html.ts"));
    expect(files).toContain(path.join("core", "edit", "apply.ts"));
  });
});

/**
 * A WYSIWYG editor is the demo's business, never the library's (ADR-0014): the ProseMirror schema and
 * the TipTap shell live in `examples/demo`, so `@petrpus/legal-docs` stays editor-agnostic and a
 * consumer picks their own. A source-wide scan is what keeps that from eroding one import at a time.
 */
describe("no editor library leaks into the package source", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
    });
  }

  it("nothing under src/ imports prosemirror or tiptap", () => {
    const offenders = sourceFiles(srcDir).filter((file) =>
      importsOf(file).some((specifier) => /prosemirror|tiptap/i.test(specifier)),
    );
    expect(offenders.map((file) => path.relative(srcDir, file))).toEqual([]);
  });

  it("scans a real file list", () => {
    expect(sourceFiles(srcDir).length).toBeGreaterThan(20);
  });
});

/**
 * The static scan reads our own sources; this reads what a consumer actually loads. `npm run build` is
 * run here rather than assumed, because the root verify command tests before it builds — a check
 * against a stale `dist/` would prove nothing.
 */
describe("the built edit bundle", () => {
  const distEdit = path.join(root, "dist", "edit.js");
  let bundle = "";

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
    bundle = readFileSync(distEdit, "utf8");
  }, 300_000);

  it("is what package.json publishes as ./edit", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      exports: Record<string, { types: string; import: string }>;
    };
    const subpath = manifest.exports["./edit"];
    expect(subpath).toEqual({ types: "./dist/edit.d.ts", import: "./dist/edit.js" });
    expect(existsSync(path.join(root, subpath!.import))).toBe(true);
    expect(existsSync(path.join(root, subpath!.types))).toBe(true);
  });

  it("imports no Node built-in and no editor library", () => {
    const specifiers = [...bundle.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]!);
    expect(specifiers.filter((specifier) => specifier.startsWith("node:"))).toEqual([]);
    expect(specifiers.filter((specifier) => /prosemirror|tiptap/i.test(specifier))).toEqual([]);
    // Only zod survives: `react` and `docx` are type-only and erased.
    expect([...new Set(specifiers)].sort()).toEqual(["zod"]);
  });

  it("is a standalone entry, not a re-export of the library chunk that carries node:crypto", () => {
    // A shared chunk would smuggle `buildEditedSnapshot`'s `node:crypto` into the browser bundle.
    expect(bundle).not.toMatch(/from\s*["']\.\/chunk-/);
  });

  it("edits a document when imported from the built package", async () => {
    const built = (await import(pathToFileURL(distEdit).href)) as typeof import("../src/edit");
    const session = built.createEditSession({ base: { body: [{ kind: "title", text: "ORIGINAL" }] } });

    expect(session.apply({ op: "setText", path: ["body", 0, "text"], value: "EDITED" }).ok).toBe(true);
    expect(session.preview()).toContain("EDITED");
  });
});

describe("the browser entry can edit and re-render", () => {
  it("renders the edited text", () => {
    const tree: DocumentTree = {
      body: [
        { kind: "title", text: "ORIGINAL TITLE" },
        { kind: "paragraph", text: "The price is 100 CZK." },
      ],
    };
    const edited = applyEdits(tree, [
      { op: "setText", path: ["body", 0, "text"], value: "EDITED TITLE" },
      { op: "setText", path: ["body", 1, "text"], value: "The price is 120 CZK." },
    ]);
    const html = renderTreeToHtml(edited);
    expect(html).toContain("EDITED TITLE");
    expect(html).toContain("The price is 120 CZK.");
    expect(html).not.toContain("ORIGINAL TITLE");
    // The input tree is untouched, so the original still renders as it did.
    expect(renderTreeToHtml(tree)).toContain("ORIGINAL TITLE");
  });

  it("drives a session, so the in-browser demo needs no second bundle", () => {
    const session = createEditSession({ base: { body: [{ kind: "title", text: "ORIGINAL TITLE" }] } });

    expect(session.apply({ op: "setText", path: ["body", 0, "text"], value: "EDITED TITLE" }).ok).toBe(true);
    expect(session.preview()).toContain("EDITED TITLE");
    expect(session.undo()).toBe(true);
    expect(session.preview()).toContain("ORIGINAL TITLE");
  });
});
