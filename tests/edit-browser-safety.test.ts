import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { applyEdits, renderTreeToHtml, type DocumentTree } from "../src/browser";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const editEntry = path.join(srcDir, "core", "edit", "index.ts");

/** Every `from "…"` / `import "…"` specifier in a TypeScript source file. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]!);
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
      const resolved = path.resolve(path.dirname(file), specifier);
      queue.push(resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
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
});
