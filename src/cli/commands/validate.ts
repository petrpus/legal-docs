import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Catalog } from "../../index";
import type { ValidationFinding } from "../../index";
import type { CliIO } from "../main";
import { loadRegistry } from "../registry";

/**
 * Percent-encode the characters GitHub's `::error` workflow command reserves in the *message* portion
 * (`%`, CR, LF) — matches the Actions toolkit's `escapeData`. Note this is deliberately narrower than
 * the toolkit's `escapeProperty` (which also escapes `:`/`,`): this helper is only ever applied to the
 * text after `::error ...::`, never to a `key=value` property, so colons/commas need no escaping here.
 */
export function escapeGithubMessage(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function githubAnnotation(finding: ValidationFinding): string {
  // `path` is a logical catalog path (e.g. "templates/hello"), not a workspace file path, so this is a
  // message-only annotation — a `file=` property would misplace or drop it (decided in Wave 5 design).
  return `::error title=legal-docs::${escapeGithubMessage(`${finding.path}: ${finding.message}`)}`;
}

export async function validateCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      catalog: { type: "string" },
      config: { type: "string" },
      github: { type: "boolean", default: false },
    },
  });

  if (!values.catalog) {
    io.writeStderr("validate: --catalog <dir> is required\n");
    return 2;
  }

  const catalog = await Catalog.fromDir(resolve(io.cwd, values.catalog));
  const registry = await loadRegistry(values.config, io.cwd);
  const result = await catalog.validate({
    ...(registry.helpers ? { helpers: registry.helpers } : {}),
    ...(registry.derivations ? { derivations: registry.derivations } : {}),
    ...(registry.customBlocks ? { customBlocks: registry.customBlocks } : {}),
  });

  if (result.ok) {
    io.writeStdout(`Catalog is valid (${values.catalog}).\n`);
    return 0;
  }

  for (const finding of result.findings) {
    io.writeStdout(`${finding.path}: ${finding.message}\n`);
    if (values.github) io.writeStdout(`${githubAnnotation(finding)}\n`);
  }
  io.writeStderr(`${result.findings.length} finding(s).\n`);
  return 1;
}
