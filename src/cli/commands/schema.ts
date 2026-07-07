import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Catalog, exportPayloadSchema } from "../../index";
import type { JsonSchemaTarget } from "../../index";
import type { CliIO } from "../main";
import { loadRegistry } from "../registry";

const TARGETS = ["draft-7", "draft-2020-12"] as const;

function isTarget(value: string): value is JsonSchemaTarget {
  return (TARGETS as readonly string[]).includes(value);
}

export async function schemaCommand(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      catalog: { type: "string" },
      config: { type: "string" },
      variant: { type: "string" },
      target: { type: "string", default: "draft-7" },
    },
  });

  const template = positionals[0];
  if (!template) {
    io.writeStderr('schema: missing <template> (usage: legal-docs schema <template> --catalog <dir> --config registry.mjs)\n');
    return 2;
  }
  if (positionals.length > 1) {
    io.writeStderr(`schema: unexpected extra argument "${positionals[1]}"\n`);
    return 2;
  }
  if (!values.catalog) {
    io.writeStderr("schema: --catalog <dir> is required\n");
    return 2;
  }
  if (!isTarget(values.target)) {
    io.writeStderr(`schema: --target must be one of ${TARGETS.join(", ")} (got "${values.target}")\n`);
    return 2;
  }

  const catalog = await Catalog.fromDir(resolve(io.cwd, values.catalog));
  const registry = await loadRegistry(values.config, io.cwd);
  const resolved = await catalog.getTemplate(template, values.variant);

  if (!resolved.payloadSchema) {
    io.writeStderr(`schema: template "${template}" declares no payloadSchema\n`);
    return 1;
  }
  const zodSchema = registry.schemas?.[resolved.payloadSchema];
  if (!zodSchema) {
    io.writeStderr(
      `schema: no schema registered for "${resolved.payloadSchema}" — pass --config with a "schemas" entry for it\n`,
    );
    return 1;
  }

  const jsonSchema = exportPayloadSchema(zodSchema, { target: values.target });
  io.writeStdout(`${JSON.stringify(jsonSchema, null, 2)}\n`);
  return 0;
}
