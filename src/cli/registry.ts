import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CustomBlockRegistry, DegradationMode } from "../custom-block";
import type { DerivationRegistry } from "../core/resolve";
import type { HelperRegistry } from "../core/helpers";
import type { PayloadSchemaRegistry } from "../core/payload";

/**
 * The code-side pieces a Catalog's templates may need (ADR-0004): payload schemas, Derivations,
 * Custom-block implementations, extra Helpers. These are functions/classes, so they cannot come from
 * a data file — a `--config` module is the CLI's escape hatch, mirroring `scripts/render-samples.mjs`.
 */
export interface CliRegistry {
  schemas?: PayloadSchemaRegistry;
  derivations?: DerivationRegistry;
  customBlocks?: CustomBlockRegistry;
  helpers?: HelperRegistry;
  /** Convenience: a `--config` may also set the default degradation mode for `render`. */
  degradation?: DegradationMode;
}

/**
 * Load a `--config` module: a plain ESM file exporting any subset of {@link CliRegistry}, either as a
 * default export or as named exports. Every CLI command works without `--config` for templates that
 * declare no schema/derivations/custom blocks/helpers.
 */
export async function loadRegistry(configPath: string | undefined, cwd: string): Promise<CliRegistry> {
  if (!configPath) return {};
  const url = pathToFileURL(resolve(cwd, configPath)).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const src = (mod.default ?? mod) as Partial<CliRegistry>;
  return {
    schemas: src.schemas,
    derivations: src.derivations,
    customBlocks: src.customBlocks,
    helpers: src.helpers,
    degradation: src.degradation,
  };
}
