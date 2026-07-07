import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { runCli, type CliIO } from "../src/cli/main";
import { escapeGithubMessage } from "../src/cli/commands/validate";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");
const badCatalogDir = path.join(here, "fixtures", "bad-catalog");
const registryPath = path.join(here, "fixtures", "cli-registry.mjs");

/** A capturing `CliIO`: chunks are recorded, not written to a real stream. */
function captureIo(cwd = catalogDir): CliIO & { text(): string; stderrText(): string; raw(): Buffer } {
  const out: (string | Buffer)[] = [];
  const err: (string | Buffer)[] = [];
  return {
    cwd,
    writeStdout: (chunk) => {
      out.push(chunk);
    },
    writeStderr: (chunk) => {
      err.push(chunk);
    },
    text: () => out.map((c) => (Buffer.isBuffer(c) ? c.toString("utf8") : c)).join(""),
    stderrText: () => err.map((c) => (Buffer.isBuffer(c) ? c.toString("utf8") : c)).join(""),
    raw: () => Buffer.concat(out.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")))),
  };
}

describe("runCli — dispatch & usage", () => {
  it("prints help and exits 0 for --help", async () => {
    const io = captureIo();
    expect(await runCli(["--help"], io)).toBe(0);
    expect(io.text()).toContain("legal-docs render");
  });

  it("prints help and exits 2 for no arguments", async () => {
    const io = captureIo();
    expect(await runCli([], io)).toBe(2);
  });

  it("exits 2 for an unknown command", async () => {
    const io = captureIo();
    expect(await runCli(["bogus"], io)).toBe(2);
    expect(io.stderrText()).toContain('Unknown command "bogus"');
  });

  it("prints help and exits 0 for a subcommand's --help (not the generic unknown-option error)", async () => {
    const io = captureIo();
    expect(await runCli(["render", "--help"], io)).toBe(0);
    expect(io.text()).toContain("legal-docs render");
  });

  it("exits 2 (not 1) when parseArgs itself rejects the invocation (unknown flag)", async () => {
    const io = captureIo();
    const code = await runCli(["render", "hello", "--catalog", ".", "--bogus", "x"], io);
    expect(code).toBe(2);
  });

  it("exits 2 (not 1) when parseArgs rejects an unexpected positional (validate takes none)", async () => {
    const io = captureIo();
    const code = await runCli(["validate", "extra-positional", "--catalog", "."], io);
    expect(code).toBe(2);
  });
});

describe("runCli render", () => {
  it("exits 2 when the template is missing", async () => {
    const io = captureIo();
    expect(await runCli(["render", "--catalog", "."], io)).toBe(2);
    expect(io.stderrText()).toContain("missing <template>");
  });

  it("exits 2 when --catalog is missing", async () => {
    const io = captureIo();
    expect(await runCli(["render", "hello"], io)).toBe(2);
    expect(io.stderrText()).toContain("--catalog");
  });

  it("exits 2 for an invalid --format", async () => {
    const io = captureIo();
    expect(await runCli(["render", "hello", "--catalog", ".", "--format", "rtf"], io)).toBe(2);
    expect(io.stderrText()).toContain("--format must be one of");
  });

  it("exits 2 for an unexpected extra positional argument", async () => {
    const io = captureIo();
    const code = await runCli(["render", "hello", "world", "--catalog", "."], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("unexpected extra argument");
  });

  it("renders with a --locale override", async () => {
    const io = captureIo();
    const code = await runCli(["render", "localized", "--catalog", ".", "--locale", "cs", "--format", "html", "--out", "-"], io);
    expect(code).toBe(0);
    expect(io.text()).toContain("<div class=\"legal-doc\">");
  });

  it("renders a schema-less template to HTML on stdout via --out -", async () => {
    const io = captureIo();
    const code = await runCli(["render", "hello", "--catalog", ".", "--format", "html", "--out", "-"], io);
    expect(code).toBe(0);
    expect(io.text()).toContain("<div class=\"legal-doc\">");
  });

  it("renders a PDF (via --config) to stdout, producing a real PDF buffer", async () => {
    const io = captureIo();
    const data = JSON.stringify({ name: "Alice", loan: { principal: { amount: 1000, currency: "EUR" } } });
    const dir = await mkdtemp(path.join(tmpdir(), "legal-docs-cli-"));
    const dataFile = path.join(dir, "data.json");
    await writeFile(dataFile, data);
    const code = await runCli(
      ["render", "greeting", "--catalog", ".", "--config", registryPath, "--data", dataFile, "--format", "pdf", "--out", "-"],
      io,
    );
    expect(code).toBe(0);
    expect(io.raw().subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("writes to a file when --out is given", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "legal-docs-cli-"));
    const io = captureIo();
    const code = await runCli(["render", "hello", "--catalog", catalogDir, "--format", "html", "--out", path.join(dir, "out.html")], io);
    expect(code).toBe(0);
    const written = await readFile(path.join(dir, "out.html"), "utf8");
    expect(written).toContain("<div class=\"legal-doc\">");
  });

  it("writes a binary format (pdf) to a file intact — not corrupted by string/encoding coercion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "legal-docs-cli-"));
    const outFile = path.join(dir, "out.pdf");
    const io = captureIo();
    const code = await runCli(["render", "hello", "--catalog", catalogDir, "--format", "pdf", "--out", outFile], io);
    expect(code).toBe(0);
    const written = await readFile(outFile);
    expect(written.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(written.length).toBeGreaterThan(500);
  });

  it("surfaces a library error (e.g. an unregistered payload schema) as exit 1", async () => {
    const io = captureIo();
    const code = await runCli(
      ["render", "pledge-agreement", "--catalog", ".", "--variant", "two-party", "--format", "html", "--out", "-"],
      io,
    );
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("No payload schema registered");
  });
});

describe("escapeGithubMessage", () => {
  it("percent-encodes %, CR and LF so a finding message can't corrupt the ::error command", () => {
    expect(escapeGithubMessage("100% done\r\nnext line")).toBe("100%25 done%0D%0Anext line");
  });

  it("leaves ordinary text unchanged", () => {
    expect(escapeGithubMessage('clause "note" does not resolve')).toBe('clause "note" does not resolve');
  });
});

describe("runCli validate", () => {
  it("exits 2 when --catalog is missing", async () => {
    const io = captureIo();
    expect(await runCli(["validate"], io)).toBe(2);
  });

  it("reports findings and exits 1 without a --config (unregistered helpers/derivations)", async () => {
    const io = captureIo();
    const code = await runCli(["validate", "--catalog", "."], io);
    expect(code).toBe(1);
    expect(io.text()).toMatch(/is not registered/);
    expect(io.stderrText()).toMatch(/\d+ finding\(s\)/);
  });

  it("is clean with the matching --config", async () => {
    const io = captureIo();
    const code = await runCli(["validate", "--catalog", ".", "--config", registryPath], io);
    expect(code).toBe(0);
    expect(io.text()).toContain("Catalog is valid");
  });

  it("emits message-only ::error annotations with --github (no file= property)", async () => {
    const io = captureIo();
    await runCli(["validate", "--catalog", ".", "--github"], io);
    const text = io.text();
    expect(text).toMatch(/::error title=legal-docs::templates\/[^:]+: .+ is not registered/);
    expect(text).not.toContain("file=");
  });

  it("reports findings for a genuinely malformed catalog", async () => {
    const io = captureIo(badCatalogDir);
    const code = await runCli(["validate", "--catalog", "."], io);
    expect(code).toBe(1);
    expect(io.text()).not.toContain("Catalog is valid");
  });
});

describe("runCli schema", () => {
  it("exits 2 when the template is missing", async () => {
    const io = captureIo();
    expect(await runCli(["schema", "--catalog", "."], io)).toBe(2);
  });

  it("exits 1 with a clear message when the template declares no payloadSchema", async () => {
    const io = captureIo();
    const code = await runCli(["schema", "hello", "--catalog", "."], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("declares no payloadSchema");
  });

  it("exits 1 with a clear message when the registry lacks the declared schema", async () => {
    const io = captureIo();
    const code = await runCli(["schema", "greeting", "--catalog", "."], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("no schema registered");
  });

  it("prints draft-7 JSON Schema by default", async () => {
    const io = captureIo();
    const code = await runCli(["schema", "greeting", "--catalog", ".", "--config", registryPath], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.text());
    expect(parsed.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(parsed.properties.name).toBeDefined();
  });

  it("supports --target draft-2020-12", async () => {
    const io = captureIo();
    const code = await runCli(["schema", "greeting", "--catalog", ".", "--config", registryPath, "--target", "draft-2020-12"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.text()).$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("supports --variant for a family template", async () => {
    const io = captureIo();
    const code = await runCli(["schema", "pledge-agreement", "--catalog", ".", "--variant", "two-party", "--config", registryPath], io);
    // pledge@1 isn't in the fixture registry, so this exercises the --variant resolution path itself
    // (getTemplate reached the variant) even though it then reports the expected missing-schema error.
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("pledge@1");
  });
});
