import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CatalogStore } from "./catalog-store";
import type { BodyItem, Template } from "../core/template";

/**
 * Loads authored content from a catalog directory: `<dir>/templates/<id>.yaml`.
 * Shape validation is intentionally light here — schema-based validation (zod) arrives with the
 * payload slice.
 */
export class FileCatalogStore implements CatalogStore {
  constructor(private readonly dir: string) {}

  async templateIds(): Promise<string[]> {
    const entries = await readdir(this.templatesDir());
    return entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""));
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

  private templatesDir(): string {
    return path.join(this.dir, "templates");
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
    // Per-item shape is validated lazily by the engine; schema (zod) validation arrives in #3.
    body: v.body as BodyItem[],
  };
}
