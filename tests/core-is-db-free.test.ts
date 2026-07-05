import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * The published core (`src/**`) must stay DB-free and product-agnostic: a DB driver only ever appears
 * in an adapter, never in core (ADR-0009). This guards against accidental coupling.
 */
describe("core stays DB-free", () => {
  it("no src/ file imports a SQLite driver", () => {
    const offenders = walk(srcDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /["'](node:sqlite|better-sqlite3)["']/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(srcDir, f));
    expect(offenders).toEqual([]);
  });
});
