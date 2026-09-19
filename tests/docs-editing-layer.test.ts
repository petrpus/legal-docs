import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as editEntry from "../src/edit/index";
import * as rootEntry from "../src/index";

/**
 * The editing layer (PRD #147, ADR-0014) is only usable if a consumer can find it. This suite is the
 * documentation counterpart of the browser-safety guard: it pins that every public symbol of the
 * `@petrpus/legal-docs/edit` subpath is named somewhere a consumer reads, that the glossary defines the
 * terms the layer introduced, that ARCHITECTURE's data flow and module table show the edit step, and
 * that the generated doc site is not stale.
 *
 * It checks *presence*, never prose — a rename or a new export fails the test, wording changes do not.
 */

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => readFileSync(path.join(repo, file), "utf8");

const readme = read("README.md");
const architecture = read("docs/ARCHITECTURE.md");
const context = read("docs/CONTEXT.md");
const changelog = read("CHANGELOG.md");

/** Where a consumer looks for the API: the entry docs. The changelog is the release-notes surface. */
const consumerDocs = `${readme}\n${architecture}`;
const allDocs = `${consumerDocs}\n${changelog}`;

/** A symbol is "named" when it appears as a whole word (so `locate` does not match "located"). */
function names(haystack: string, symbol: string): boolean {
  return new RegExp(`(^|[^\\w$])${symbol.replace(/\$/g, "\\$")}($|[^\\w$])`).test(haystack);
}

describe("the editing layer is documented", () => {
  it("every public value of the ./edit subpath is named in README, ARCHITECTURE or CHANGELOG", () => {
    const undocumented = Object.keys(editEntry).filter((symbol) => !names(allDocs, symbol));
    expect(undocumented).toEqual([]);
  });

  it("the entry points a consumer starts from are named in README or ARCHITECTURE", () => {
    // The server-side half lives on the root entry; assert the names are real before asserting on prose.
    const serverSide = [
      "buildEditedSnapshot",
      "verifyEditedSnapshot",
      "renderEdited",
      "renderRedlineToDocx",
    ] as const;
    expect(serverSide.filter((symbol) => !(symbol in rootEntry))).toEqual([]);

    const headline = [
      ...serverSide,
      "createEditSession",
      "applyEdits",
      "diffTree",
      "buildRedline",
      "renderRedlineHtml",
      "renderReviewHtml",
      "normalizeTree",
      "EditSet",
      "EditOp",
      "RedlineDoc",
      "TreePath",
    ];
    expect(headline.filter((symbol) => !names(consumerDocs, symbol))).toEqual([]);
    expect(consumerDocs).toContain("@petrpus/legal-docs/edit");
  });

  it("ARCHITECTURE shows the edit step in the data flow and the edit module in the table", () => {
    const [, dataFlow = ""] = /## Data flow\n([\s\S]*?)\n## /.exec(architecture) ?? [];
    expect(dataFlow).toContain("applyEdits");
    expect(dataFlow).toContain("Edit set");
    // One row per module; the editing layer is a module of its own, not a footnote.
    expect(architecture).toMatch(/^\| `edit` \|/m);
  });

  it("CONTEXT defines the terms the editing layer introduced", () => {
    for (const term of [
      "Edit set",
      "Edit op",
      "Tree path",
      "Edited Snapshot",
      "Base Snapshot",
      "Redline",
      "Comment",
      "Edit session",
    ]) {
      expect(context).toContain(`**${term}**:`);
    }
    // The glossary is the place the two "edit audits" are told apart (ADR-0009 vs ADR-0014).
    const [, editAudit = ""] = /\*\*Content audit\*\* vs \*\*Edit audit\*\*:\n([\s\S]*?)\n\n/.exec(context) ?? [];
    expect(editAudit).toContain("ADR-0009");
    expect(editAudit).toContain("ADR-0014");
    // A DocumentNode still has no id — that is *why* an edit addresses it by Tree path.
    const [, documentNode = ""] = /\*\*DocumentNode\*\*:\n([\s\S]*?)\n\n/.exec(context) ?? [];
    expect(documentNode).toContain("Tree path");
  });

  it("the generated doc site carries the sections of its sources", () => {
    const pages = [
      ["README.md", "docs/index.html"],
      ["docs/ARCHITECTURE.md", "docs/ARCHITECTURE.html"],
      ["docs/CONTEXT.md", "docs/CONTEXT.html"],
      ["CHANGELOG.md", "docs/CHANGELOG.html"],
    ] as const;
    for (const [source, generated] of pages) {
      const html = read(generated);
      const headings = [...read(source).matchAll(/^#{2,3} (.+)$/gm)]
        .map(([, heading = ""]) => heading.replace(/[`*]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;"))
        // A heading carrying a link renders as markup, not as its source text — skip those.
        .filter((heading) => !heading.includes("["));
      const stale = headings.filter((heading) => !html.includes(heading));
      expect(stale, `${generated} is stale — run \`npm run docs:build\``).toEqual([]);
    }
  });
});
