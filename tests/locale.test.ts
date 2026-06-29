import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");

const EN = "Welcome to this agreement between the parties.";
const CS = "Vítejte u této smlouvy mezi stranami.";

describe("per-render locale override", () => {
  it("uses the template's own locale by default", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const { html, snapshot } = await renderDocument({ catalog, template: "localized", format: "html" });

    expect(html).toContain(EN);
    expect(html).not.toContain(CS);
    expect(snapshot.locale).toBe("en");
  });

  it("renders the Clause in the requested locale when overridden", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const cs = await renderDocument({ catalog, template: "localized", locale: "cs", format: "html" });

    expect(cs.html).toContain(CS);
    expect(cs.html).not.toContain(EN);
    expect(cs.snapshot.locale).toBe("cs"); // the resolved locale is frozen in the Snapshot
  });

  it("falls back to an available locale when the requested one has no file, recording the request", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const fr = await renderDocument({ catalog, template: "localized", locale: "fr", format: "html", snapshotMode: "pins" });

    expect(fr.html).toMatch(new RegExp(`${escapeRe(EN)}|${escapeRe(CS)}`)); // fell back, did not error
    expect(fr.snapshot.locale).toBe("fr"); // the requested locale
    // The pin freezes the *resolved* locale (the file that loaded), so a pins re-render is deterministic.
    expect(["en", "cs"]).toContain(fr.snapshot.pins?.[0]?.resolvedLocale);
  });

  it("re-renders a non-default-locale Snapshot in the frozen locale (full and pins)", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const full = await renderDocument({ catalog, template: "localized", locale: "cs", format: "pdf", snapshotMode: "full" });
    const reFull = await renderFromSnapshot(full.snapshot, { format: "html" });
    expect(reFull.html).toContain(CS);

    const pins = await renderDocument({ catalog, template: "localized", locale: "cs", format: "pdf", snapshotMode: "pins" });
    const rePins = await renderFromSnapshot(pins.snapshot, { catalog, format: "html" });
    expect(rePins.html).toContain(CS);
    expect(rePins.html).not.toContain(EN);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
