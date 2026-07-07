import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Catalog, renderDocument } from "../../index";
import type { CliIO } from "../main";
import { loadRegistry } from "../registry";

const FORMATS = ["pdf", "html", "docx"] as const;
type Format = (typeof FORMATS)[number];

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

export async function renderCommand(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      catalog: { type: "string" },
      data: { type: "string" },
      variant: { type: "string" },
      locale: { type: "string" },
      format: { type: "string", default: "pdf" },
      out: { type: "string" },
      config: { type: "string" },
    },
  });

  const template = positionals[0];
  if (!template) {
    io.writeStderr('render: missing <template> (usage: legal-docs render <template> --catalog <dir>)\n');
    return 2;
  }
  if (positionals.length > 1) {
    io.writeStderr(`render: unexpected extra argument "${positionals[1]}"\n`);
    return 2;
  }
  if (!values.catalog) {
    io.writeStderr("render: --catalog <dir> is required\n");
    return 2;
  }
  if (!isFormat(values.format)) {
    io.writeStderr(`render: --format must be one of ${FORMATS.join(", ")} (got "${values.format}")\n`);
    return 2;
  }

  const catalog = await Catalog.fromDir(resolve(io.cwd, values.catalog));
  const registry = await loadRegistry(values.config, io.cwd);
  const data = values.data ? JSON.parse(await readFile(resolve(io.cwd, values.data), "utf8")) : {};

  const result = await renderDocument({
    catalog,
    template,
    ...(values.variant ? { variant: values.variant } : {}),
    ...(values.locale ? { locale: values.locale } : {}),
    data,
    format: values.format,
    ...(registry.schemas ? { schemas: registry.schemas } : {}),
    ...(registry.derivations ? { derivations: registry.derivations } : {}),
    ...(registry.helpers ? { helpers: registry.helpers } : {}),
    ...(registry.customBlocks ? { customBlocks: registry.customBlocks } : {}),
    ...(registry.degradation ? { degradation: registry.degradation } : {}),
  });

  const payload: string | Buffer = result.format === "html" ? result.html : result.buffer;
  const outPath = values.out ?? `${template}${values.variant ? `-${values.variant}` : ""}.${values.format}`;
  if (outPath === "-") {
    io.writeStdout(payload);
  } else {
    await writeFile(resolve(io.cwd, outPath), payload);
    io.writeStderr(`Wrote ${outPath}\n`);
  }
  return 0;
}
