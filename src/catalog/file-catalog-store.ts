import { access, readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CatalogStore } from "./catalog-store";
import type { BaseTemplate, BodyItem, Include, Template, Variant } from "../core/template";
import type { Clause } from "../core/clause";
import type { VarsSchema } from "../core/vars-schema";

/**
 * Loads authored content from a catalog directory:
 * `<dir>/templates/<id>.yaml` and `<dir>/clauses/<id>/v<N>.<locale>.yaml`.
 * Shape validation is intentionally light here — schema-based validation (zod) is applied to payload
 * data in the facade, and catalog integrity-lint is a later slice.
 */
export class FileCatalogStore implements CatalogStore {
  constructor(private readonly dir: string) {}

  async templateIds(): Promise<string[]> {
    const entries = await readdir(this.templatesDir(), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
      .map((e) => e.name.replace(/\.ya?ml$/, ""));
  }

  /** A family is a `templates/<id>/` directory holding a `base.yaml`. */
  async familyIds(): Promise<string[]> {
    const entries = await readdir(this.templatesDir(), { withFileTypes: true }).catch(emptyIfMissing<Dirent>);
    const families: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await this.hasBase(entry.name)) families.push(entry.name);
    }
    return families;
  }

  async variantIds(family: string): Promise<string[]> {
    const entries = await readdir(this.familyDir(family)).catch(emptyIfMissing<string>);
    return entries
      .filter((f) => /\.ya?ml$/.test(f) && !/^base\.ya?ml$/.test(f))
      .map((f) => f.replace(/\.ya?ml$/, ""));
  }

  async loadBase(family: string): Promise<BaseTemplate> {
    const file = await this.resolveFamilyFile(family, "base");
    return toBase(parseYaml(await readFile(file, "utf8")), family);
  }

  async loadVariant(family: string, variant: string): Promise<Variant> {
    const file = await this.resolveFamilyFile(family, variant);
    return toVariant(parseYaml(await readFile(file, "utf8")), family, variant);
  }

  private async hasBase(family: string): Promise<boolean> {
    for (const ext of [".yaml", ".yml"]) {
      if (await fileExists(path.join(this.familyDir(family), `base${ext}`))) return true;
    }
    return false;
  }

  private async resolveFamilyFile(family: string, name: string): Promise<string> {
    for (const ext of [".yaml", ".yml"]) {
      const file = path.join(this.familyDir(family), `${name}${ext}`);
      if (await fileExists(file)) return file;
    }
    throw new Error(`"${name}" not found in family "${family}" (${this.familyDir(family)})`);
  }

  async loadTemplate(id: string): Promise<Template> {
    const file = await this.resolveTemplateFile(id);
    const raw = await readFile(file, "utf8");
    return toTemplate(parseYaml(raw), id);
  }

  /** Resolve `<id>.yaml` or `<id>.yml`, mirroring what `templateIds()` discovers. */
  private async resolveTemplateFile(id: string): Promise<string> {
    for (const ext of [".yaml", ".yml"]) {
      const file = path.join(this.templatesDir(), `${id}${ext}`);
      if (await fileExists(file)) return file;
    }
    throw new Error(`Template "${id}" not found in ${this.templatesDir()}`);
  }

  async loadInclude(id: string): Promise<Include> {
    for (const ext of [".yaml", ".yml"]) {
      const file = path.join(this.partialsDir(), `${id}${ext}`);
      if (await fileExists(file)) return toInclude(parseYaml(await readFile(file, "utf8")), id);
    }
    throw new Error(`Include "${id}" not found in ${this.partialsDir()}`);
  }

  async clauseVersions(id: string): Promise<number[]> {
    const entries = await readdir(this.clauseDir(id)).catch(() => [] as string[]);
    const versions = new Set<number>();
    for (const file of entries) {
      const match = /^v(\d+)\.[^.]+\.ya?ml$/.exec(file);
      if (match) versions.add(Number(match[1]));
    }
    return [...versions].sort((a, b) => a - b);
  }

  async loadClause(id: string, version: number, locale: string): Promise<Clause> {
    const file = await this.resolveClauseFile(id, version, locale);
    const raw = await readFile(file, "utf8");
    return toClause(parseYaml(raw), id, version);
  }

  /** Prefer `v<N>.<locale>.yaml`; fall back to any locale of that version. */
  private async resolveClauseFile(id: string, version: number, locale: string): Promise<string> {
    for (const ext of [".yaml", ".yml"]) {
      const file = path.join(this.clauseDir(id), `v${version}.${locale}${ext}`);
      if (await fileExists(file)) return file;
    }
    const entries = await readdir(this.clauseDir(id)).catch(() => [] as string[]);
    const fallback = entries.find((f) => new RegExp(`^v${version}\\.[^.]+\\.ya?ml$`).test(f));
    if (fallback) return path.join(this.clauseDir(id), fallback);
    throw new Error(`Clause "${id}" v${version} not found for locale "${locale}"`);
  }

  private templatesDir(): string {
    return path.join(this.dir, "templates");
  }

  private partialsDir(): string {
    return path.join(this.dir, "partials");
  }

  private familyDir(family: string): string {
    return path.join(this.templatesDir(), family);
  }

  private clauseDir(id: string): string {
    return path.join(this.dir, "clauses", id);
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** A `readdir` rejection handler: empty for a missing directory, rethrow any real I/O error. */
function emptyIfMissing<T>(error: unknown): T[] {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
  throw error;
}

function toTemplate(value: unknown, id: string): Template {
  if (value === null || typeof value !== "object") {
    throw new Error(`Template "${id}" is not a YAML object`);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.template !== "string") {
    throw new Error(`Template "${id}" is missing a string "template" id`);
  }
  if (!Array.isArray(v.body)) {
    throw new Error(`Template "${id}" is missing a "body" array`);
  }
  return {
    template: v.template,
    version: typeof v.version === "number" ? v.version : 1,
    locale: typeof v.locale === "string" ? v.locale : "en",
    payloadSchema: typeof v.payloadSchema === "string" ? v.payloadSchema : undefined,
    derivations: Array.isArray(v.derivations)
      ? v.derivations.filter((d): d is string => typeof d === "string")
      : undefined,
    // Per-item shape is validated lazily by the engine; payload (zod) validation is applied to the
    // data, not the template, in the facade.
    body: v.body as BodyItem[],
  };
}

function toBase(value: unknown, family: string): BaseTemplate {
  if (value === null || typeof value !== "object") {
    throw new Error(`Base of family "${family}" is not a YAML object`);
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.body)) {
    throw new Error(`Base of family "${family}" is missing a "body" array`);
  }
  return {
    base: typeof v.base === "string" ? v.base : family,
    version: typeof v.version === "number" ? v.version : 1,
    locale: typeof v.locale === "string" ? v.locale : "en",
    payloadSchema: typeof v.payloadSchema === "string" ? v.payloadSchema : undefined,
    derivations: Array.isArray(v.derivations)
      ? v.derivations.filter((d): d is string => typeof d === "string")
      : undefined,
    // Per-item shape is validated lazily by the engine, as in toTemplate.
    body: v.body as BodyItem[],
  };
}

function toVariant(value: unknown, family: string, variant: string): Variant {
  if (value === null || typeof value !== "object") {
    throw new Error(`Variant "${variant}" of family "${family}" is not a YAML object`);
  }
  const v = value as Record<string, unknown>;
  return {
    variant: typeof v.variant === "string" ? v.variant : variant,
    // `extends` defaults to the containing family dir, so the composeTemplate mismatch guard only
    // fires on an explicitly wrong value — omitting it is the common, correct case.
    extends: typeof v.extends === "string" ? v.extends : family,
    parties: Array.isArray(v.parties)
      ? v.parties.filter((p): p is string => typeof p === "string")
      : undefined,
    // Override fills are body-item arrays, validated lazily by the engine like template bodies.
    overrides: isRecord(v.overrides) ? (v.overrides as Record<string, BodyItem[]>) : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInclude(value: unknown, id: string): Include {
  if (value === null || typeof value !== "object") {
    throw new Error(`Include "${id}" is not a YAML object`);
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.body)) {
    throw new Error(`Include "${id}" is missing a "body" array`);
  }
  return {
    id: typeof v.id === "string" ? v.id : id,
    // Per-item shape is validated lazily by the engine (same as toTemplate); the YAML body array is
    // the only structural guarantee made here.
    body: v.body as BodyItem[],
  };
}

function toClause(value: unknown, id: string, version: number): Clause {
  if (value === null || typeof value !== "object") {
    throw new Error(`Clause "${id}" v${version} is not a YAML object`);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string") {
    throw new Error(`Clause "${id}" v${version} is missing a string "text"`);
  }
  return {
    clause: typeof v.clause === "string" ? v.clause : id,
    version: typeof v.version === "number" ? v.version : version,
    locale: typeof v.locale === "string" ? v.locale : "en",
    vars: (v.vars ?? {}) as VarsSchema,
    text: v.text,
  };
}
