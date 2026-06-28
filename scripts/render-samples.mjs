// Render every sample document to samples/<name>.pdf (and .png if `pdftoppm` is available).
// Run with: npm run samples   (builds first, then executes this against dist/).
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { Text, View } from "@react-pdf/renderer";
import { BorderStyle, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { z } from "zod";
import { Catalog, renderDocument, party, loan, escapeHtml, halfPoints, twips, eighths } from "../dist/index.js";

// A worked signature-grid Custom block (mirrors examples/signature-grid.tsx, using createElement so
// this plain-ESM script needs no JSX/TS build). A multi-column grid of signature cells.
const signatureGridSchema = z.object({
  signatories: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  columns: z.number().int().positive().optional(),
});
const signatureGrid = {
  schema: signatureGridSchema,
  pdf: (props, { theme }) => {
    const { signatories, columns = 2 } = signatureGridSchema.parse(props);
    const cellWidth = `${100 / columns}%`;
    return createElement(
      View,
      { style: { flexDirection: "row", flexWrap: "wrap" } },
      signatories.map((s, i) =>
        createElement(
          View,
          { key: i, style: { width: cellWidth, paddingRight: 12, marginBottom: 16 } },
          createElement(View, {
            style: { marginTop: 28, borderTopWidth: 1, borderColor: theme.color.text, marginBottom: 4 },
          }),
          createElement(Text, { style: { fontSize: theme.fontSize.paragraph } }, s.name),
          s.role !== undefined ? createElement(Text, { style: { fontSize: theme.signatures.fontSize, color: theme.signatures.roleColor } }, s.role) : null,
        ),
      ),
    );
  },
  html: (props, { theme }) => {
    const { signatories, columns = 2 } = signatureGridSchema.parse(props);
    const cellWidth = `${100 / columns}%`;
    const line = `border-top:${theme.signatures.lineWidth}px solid ${theme.signatures.lineColor};margin-top:${theme.signatures.lineSpace}px;margin-bottom:4px;`;
    const cells = signatories
      .map((s) => {
        const role = s.role !== undefined ? `<div style="font-size:${theme.signatures.fontSize}px;color:${theme.signatures.roleColor}">${escapeHtml(s.role)}</div>` : "";
        return `<div class="sig-cell" style="width:${cellWidth};padding-right:12px;margin-bottom:16px;box-sizing:border-box"><div class="sig-cell__line" style="${line}"></div><div>${escapeHtml(s.name)}</div>${role}</div>`;
      })
      .join("");
    return `<div class="sig-grid" style="display:flex;flex-wrap:wrap">${cells}</div>`;
  },
  docx: (props, { theme }) => {
    const { signatories, columns = 2 } = signatureGridSchema.parse(props);
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
    return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none }, rows })];
  },
};

const root = new URL("..", import.meta.url).pathname;
const outDir = `${root}samples`;
mkdirSync(outDir, { recursive: true });

const catalog = await Catalog.fromDir(`${root}legal-docs`);

const partyData = {
  lender: { name: "Acme Bank a.s.", kind: "company", idNumber: "12345678", address: "1 Bank Street, Prague" },
  borrower: { name: "Jane Doe", kind: "person" },
  loan: { principal: { amount: 250000, currency: "EUR" } },
};
const termsData = {
  parties: [
    { name: "Alpha Capital", role: "Lender" },
    { name: "Beta Holdings", role: "Pledgor" },
    { name: "Gamma Trust", role: "Accession Debtor" },
  ],
  hasGuarantor: true,
};

// One entry per sample template: the data/schemas/derivations it needs.
const samples = {
  hello: {},
  agreement: {},
  contract: {},
  greeting: {
    data: { name: "Alice", loan: { principal: { amount: 1000, currency: "EUR" } } },
    schemas: { "greeting@1": z.object({ name: z.string(), loan }) },
  },
  parties: {
    data: partyData,
    schemas: { "parties@1": z.object({ lender: party, borrower: party, loan }) },
  },
  signoff: {
    data: { lender: { name: "Acme Bank a.s." }, witness: "John Watson" },
    schemas: { "signoff@1": z.object({ lender: party, witness: z.string() }) },
  },
  terms: {
    data: termsData,
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
  },
  "signature-grid": {
    data: {
      signatories: [
        { name: "Acme Bank a.s.", role: "Lender" },
        { name: "Jane Doe", role: "Borrower" },
        { name: "Guarantor Ltd", role: "Guarantor" },
      ],
    },
    customBlocks: { "signature-grid": signatureGrid },
  },
};

const hasPdftoppm = (() => {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Standalone templates: one render each. Variant families are rendered separately below.
const pledgeSchema = { "pledge@1": z.object({ parties: z.array(party) }) };
const variantSamples = [
  {
    template: "pledge-agreement",
    variant: "two-party",
    schemas: pledgeSchema,
    data: { parties: [{ name: "Acme Bank a.s." }, { name: "Jane Doe" }] },
  },
  {
    template: "pledge-agreement",
    variant: "three-party",
    schemas: pledgeSchema,
    data: { parties: [{ name: "Acme Bank a.s." }, { name: "Jane Doe" }, { name: "Guarantor Ltd" }] },
  },
];

async function render(name, config) {
  const { buffer, snapshotId } = await renderDocument({ catalog, format: "pdf", ...config });
  const pdfPath = `${outDir}/${name}.pdf`;
  writeFileSync(pdfPath, buffer);
  if (hasPdftoppm) {
    execFileSync("pdftoppm", ["-png", "-r", "110", "-singlefile", pdfPath, `${outDir}/${name}`]);
  }
  // Separate html and docx passes over the same inputs; their Snapshots match the pdf one, so ignored.
  const { html } = await renderDocument({ catalog, format: "html", ...config });
  writeFileSync(`${outDir}/${name}.html`, html);
  const docx = await renderDocument({ catalog, format: "docx", ...config });
  writeFileSync(`${outDir}/${name}.docx`, docx.buffer);
  console.log(`✓ ${name}.pdf + ${name}.html + ${name}.docx${hasPdftoppm ? ` + ${name}.png` : ""}  (snapshot ${snapshotId})`);
}

for (const id of await catalog.templateIds()) {
  const config = samples[id];
  if (!config) {
    console.warn(`! no sample config for "${id}" — skipping`);
    continue;
  }
  await render(id, { template: id, ...config });
}

for (const config of variantSamples) {
  await render(`${config.template}-${config.variant}`, config);
}

console.log(`\nWrote samples to ${outDir}${hasPdftoppm ? "" : "  (install poppler-utils for .png too)"}`);
