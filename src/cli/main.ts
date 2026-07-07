import { renderCommand } from "./commands/render";
import { validateCommand } from "./commands/validate";
import { schemaCommand } from "./commands/schema";

/** I/O the CLI writes through — injectable so tests can capture output without touching real streams. */
export interface CliIO {
  writeStdout(chunk: string | Buffer): void;
  writeStderr(chunk: string | Buffer): void;
  cwd: string;
}

function defaultIo(): CliIO {
  return {
    writeStdout: (chunk) => {
      process.stdout.write(chunk);
    },
    writeStderr: (chunk) => {
      process.stderr.write(chunk);
    },
    cwd: process.cwd(),
  };
}

export const HELP = `legal-docs — render legal documents and lint a catalog from the command line

Usage:
  legal-docs render <template> --catalog <dir> [--data file.json] [--variant v] [--locale l]
                     [--format pdf|html|docx] [--out file|-] [--config registry.mjs]
  legal-docs validate --catalog <dir> [--config registry.mjs] [--github]
  legal-docs schema <template> --catalog <dir> --config registry.mjs [--variant v]
                     [--target draft-7|draft-2020-12]
  legal-docs --help

"--config" points at an ESM module exporting any of { schemas, derivations, customBlocks, helpers,
degradation } — the code-side registries a Catalog's templates may reference (ADR-0004). Every command
works without it for templates that need none.
`;

/** True for the `TypeError`s `node:util`'s `parseArgs` throws on a bad invocation (unknown/extra/
 * malformed option) — these are usage errors (exit 2), not runtime failures (exit 1). */
function isArgsUsageError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === "string" && (error as { code: string }).code.startsWith("ERR_PARSE_ARGS_");
}

/**
 * The CLI entry point: parses the subcommand and delegates. Returns the process exit code (never
 * throws) so both `bin.ts` and tests can treat it uniformly. Exit codes: 0 ok, 1 findings/render
 * failure, 2 usage error (including a malformed invocation `parseArgs` itself rejects).
 */
export async function runCli(argv: string[], io: CliIO = defaultIo()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.writeStdout(HELP);
    return command === undefined ? 2 : 0;
  }
  // A subcommand's own `--help`/`-h` is handled uniformly here (before its parseArgs, which does not
  // declare `help` as an option and would otherwise reject it as an unknown flag).
  if (rest.includes("--help") || rest.includes("-h")) {
    io.writeStdout(HELP);
    return 0;
  }
  try {
    switch (command) {
      case "render":
        return await renderCommand(rest, io);
      case "validate":
        return await validateCommand(rest, io);
      case "schema":
        return await schemaCommand(rest, io);
      default:
        io.writeStderr(`Unknown command "${command}"\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.writeStderr(`Error: ${message}\n`);
    return isArgsUsageError(error) ? 2 : 1;
  }
}
