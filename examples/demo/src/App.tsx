import { useEffect, useMemo, useState } from "react";

type Format = "html" | "pdf" | "docx";

interface TemplateInfo {
  id: string;
  variants?: string[];
  data?: unknown;
}
interface Meta {
  templates: TemplateInfo[];
  locales: string[];
  defaultTheme: Record<string, unknown>;
  diff: { clause: string; from: number; to: number };
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Known enum Theme tokens, rendered as a <select> in the editor (matched by the token's current value).
// Safe because the Theme has no free-form string tokens today (every string leaf is a #rrggbb colour or
// one of these enums); a free-form string token whose value equalled "left"/"A4"/… would need path-based
// detection instead.
const ENUMS: readonly string[][] = [
  ["left", "center", "right", "justify"], // align.title / align.paragraph
  ["A3", "A4", "A5", "LETTER", "LEGAL", "TABLOID"], // page.size
  ["portrait", "landscape"], // page.orientation
];

type Tab = "render" | "diff" | "editor";

export function App() {
  const [meta, setMeta] = useState<Meta>();
  const [tab, setTab] = useState<Tab>("render");

  useEffect(() => {
    fetch("/api/meta").then((r) => r.json()).then(setMeta);
  }, []);

  if (!meta) return <main style={S.page}>Loading…</main>;

  return (
    <main style={S.page}>
      <h1 style={{ margin: 0 }}>@petrpus/legal-docs — demo</h1>
      <p style={S.muted}>
        Live theme / locale / format over the sample catalog, a Clause diff, and a runtime Clause
        editor. Everything runs in the dev server (Node); the browser is a thin client.
      </p>
      <nav style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button style={tab === "render" ? S.tabOn : S.tab} onClick={() => setTab("render")}>Render</button>
        <button style={tab === "diff" ? S.tabOn : S.tab} onClick={() => setTab("diff")}>Clause diff</button>
        <button style={tab === "editor" ? S.tabOn : S.tab} onClick={() => setTab("editor")}>Editor (Phase 7)</button>
      </nav>
      {tab === "render" && <RenderTab meta={meta} />}
      {tab === "diff" && <DiffTab meta={meta} />}
      {tab === "editor" && <EditorTab />}
    </main>
  );
}

function RenderTab({ meta }: { meta: Meta }) {
  const [templateId, setTemplateId] = useState("parties");
  const [variant, setVariant] = useState("");
  const [locale, setLocale] = useState("en");
  const [format, setFormat] = useState<Format>("html");
  const [theme, setTheme] = useState(meta.defaultTheme);
  const [dataText, setDataText] = useState("{}");
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [schemaJson, setSchemaJson] = useState("");

  const template = useMemo(() => meta.templates.find((t) => t.id === templateId), [meta, templateId]);
  const needsData = template?.data !== undefined;

  // Reset variant + prefill the sample payload whenever the template changes.
  useEffect(() => {
    setVariant(template?.variants?.[0] ?? "");
    setDataText(template?.data !== undefined ? JSON.stringify(template.data, null, 2) : "{}");
    setSchemaJson("");
  }, [template]);

  async function exportSchema() {
    setError("");
    try {
      const res = await fetch("/api/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: templateId }),
      }).then((r) => r.json());
      if (res.error) setError(res.error);
      else setSchemaJson(JSON.stringify(res.schemas, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function render() {
    setBusy(true);
    setError("");
    try {
      const data = needsData ? JSON.parse(dataText) : {};
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: templateId, variant: variant || undefined, locale, theme, format, data }),
      }).then((r) => r.json());
      if (res.error) {
        setError(res.error);
        setHtml("");
      } else if (format === "html") {
        setHtml(res.html);
      } else {
        download(res.base64, `${templateId}${variant ? "-" + variant : ""}.${format}`, MIME[format]!);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={S.cols}>
      <section style={S.panel}>
        <Field label="Template">
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={S.input}>
            {meta.templates.map((t) => <option key={t.id}>{t.id}</option>)}
          </select>
        </Field>
        {template?.variants && (
          <Field label="Variant">
            <select value={variant} onChange={(e) => setVariant(e.target.value)} style={S.input}>
              {template.variants.map((v) => <option key={v}>{v}</option>)}
            </select>
          </Field>
        )}
        <Field label="Locale (used by `localized`)">
          <select value={locale} onChange={(e) => setLocale(e.target.value)} style={S.input}>
            {meta.locales.map((l) => <option key={l}>{l}</option>)}
          </select>
        </Field>
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)} style={S.input}>
            <option value="html">html (preview)</option>
            <option value="pdf">pdf (download)</option>
            <option value="docx">docx (download)</option>
          </select>
        </Field>
        {needsData && (
          <Field label="Payload (typed — invalid data fails validation)">
            <textarea value={dataText} onChange={(e) => setDataText(e.target.value)} rows={8} style={{ ...S.input, fontFamily: "monospace" }} />
          </Field>
        )}
        <h3 style={S.h3}>Theme</h3>
        <ThemeEditor theme={theme} onChange={setTheme} onReset={() => setTheme(meta.defaultTheme)} />
        <button style={S.primary} onClick={render} disabled={busy}>{busy ? "Rendering…" : "Render"}</button>
        {needsData && (
          <button style={S.secondary} onClick={exportSchema}>Export JSON Schema</button>
        )}
        {error && <pre style={S.error}>{error}</pre>}
      </section>
      <section style={S.preview}>
        {schemaJson ? (
          <>
            <h3 style={S.h3}>Payload JSON Schema (draft-7)</h3>
            <pre style={{ ...S.input, fontFamily: "monospace", whiteSpace: "pre", overflow: "auto", maxHeight: "70vh" }}>{schemaJson}</pre>
          </>
        ) : format === "html" ? (
          html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <p style={S.muted}>Render to preview the HTML here. Headers/footers show only in the PDF/DOCX download (try the “nda-headed” template).</p>
        ) : (
          <p style={S.muted}>{format.toUpperCase()} downloads on render (binary — not previewable in the browser).</p>
        )}
      </section>
    </div>
  );
}

function DiffTab({ meta }: { meta: Meta }) {
  const [from, setFrom] = useState(meta.diff.from);
  const [to, setTo] = useState(meta.diff.to);
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");

  async function run() {
    setError("");
    const res = await fetch("/api/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clause: meta.diff.clause, from, to }),
    }).then((r) => r.json());
    if (res.error) setError(res.error);
    else setHtml(res.html);
  }

  return (
    <div style={S.cols}>
      <section style={S.panel}>
        <p style={S.muted}>Diff two versions of the <code>{meta.diff.clause}</code> Clause.</p>
        <Field label="from version"><input type="number" value={from} onChange={(e) => setFrom(Number(e.target.value))} style={S.input} /></Field>
        <Field label="to version"><input type="number" value={to} onChange={(e) => setTo(Number(e.target.value))} style={S.input} /></Field>
        <button style={S.primary} onClick={run}>Diff</button>
        {error && <pre style={S.error}>{error}</pre>}
      </section>
      <section style={S.preview}>
        {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <p style={S.muted}>Run to see the structured diff rendered as HTML.</p>}
      </section>
    </div>
  );
}

interface EditState {
  clauses: { id: string; versions: number[]; latestVersion: number | null; latestText: string | null }[];
  drafts: { id: string; version: number; status: string; locales: string[] }[];
  audit: { id: string; at: string; actor: { id: string; name?: string }; action: string; from?: string; to?: string; revision?: { version?: number } }[];
  actor: { name: string };
}
interface Finding { path: string; message: string }

/**
 * The runtime Clause editor (ADR-0009): draft → in_review → published over the library's editing API,
 * backed by an in-memory editable store in the dev server. Shows the validate()-gated publish, the
 * old→new review diff, and the edit audit trail.
 */
function EditorTab() {
  const [state, setState] = useState<EditState>();
  const [id, setId] = useState("welcome");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [diffHtml, setDiffHtml] = useState("");

  const refresh = () => fetch("/api/editing/state").then((r) => r.json()).then(setState);
  useEffect(() => { refresh(); }, []);

  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    setMsg(""); setFindings([]); setDiffHtml("");
    const res = await fetch(`/api/editing/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    if (res.error) setMsg(`⚠ ${res.error}`);
    else if (res.ok === false && res.findings) { setFindings(res.findings); setMsg("Publish blocked — fix the findings below."); }
    else if (res.html) setDiffHtml(res.html);
    else setMsg("Done.");
    await refresh();
    return res;
  }

  if (!state) return <p style={S.muted}>Loading editor…</p>;

  const draftFor = (cid: string) => state.drafts.find((d) => d.id === cid);

  return (
    <div style={S.cols}>
      <section style={S.panel}>
        <h3 style={S.h3}>Clauses</h3>
        {state.clauses.map((c) => (
          <div key={c.id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid #eee" }}>
            <div><strong>{c.id}</strong> <span style={S.muted}>v{c.versions.join(", ") || "—"}{c.latestVersion ? ` · @latest = v${c.latestVersion}` : ""}</span></div>
            {c.latestText && <div style={{ fontSize: 12, color: "#444", margin: "2px 0 4px" }}>{c.latestText}</div>}
            <button style={S.tab} onClick={() => { setId(c.id); setText(c.latestText ?? ""); }}>Edit → new version</button>
          </div>
        ))}

        <h3 style={S.h3}>New / edit draft</h3>
        <Field label="Clause id"><input value={id} onChange={(e) => setId(e.target.value)} style={S.input} /></Field>
        <Field label="Text (en)"><textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} style={{ ...S.input, fontFamily: "inherit" }} /></Field>
        {(() => {
          // Reuse an open draft for this id (update) instead of allocating another version each click.
          const open = draftFor(id);
          return open && open.status === "draft" ? (
            <button style={S.primary} onClick={() => call("update", { id, version: open.version, locale: "en", text })}>Update draft v{open.version}</button>
          ) : (
            <button style={S.primary} onClick={() => call("create", { id, locale: "en", text })}>Create draft (new version)</button>
          );
        })()}
        {msg && <p style={msg.startsWith("⚠") || msg.startsWith("Publish blocked") ? S.error : { ...S.muted, marginTop: 8 }}>{msg}</p>}

        <h3 style={S.h3}>Drafts</h3>
        {state.drafts.length === 0 && <p style={S.muted}>No drafts — create one above.</p>}
        {state.drafts.map((d) => (
          <div key={`${d.id}-${d.version}`} style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <div><strong>{d.id}</strong> v{d.version} <span style={{ ...S.badge, background: d.status === "in_review" ? "#fef3c7" : "#e0e7ff" }}>{d.status}</span></div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              <button style={S.tab} onClick={() => call("diff", { id: d.id, version: d.version, locale: "en" })}>Diff</button>
              {d.status === "draft" && <button style={S.tab} onClick={() => call("submit", { id: d.id, version: d.version })}>Submit for review</button>}
              {d.status === "in_review" && <button style={S.tab} onClick={() => call("withdraw", { id: d.id, version: d.version })}>Withdraw</button>}
              {d.status === "in_review" && <button style={S.primary} onClick={() => call("publish", { id: d.id, version: d.version })}>Publish</button>}
              <button style={S.tab} onClick={() => call("delete", { id: d.id, version: d.version })}>Delete</button>
            </div>
          </div>
        ))}
      </section>

      <section style={S.preview}>
        {findings.length > 0 && (
          <div style={S.error}>
            <strong>Publish blocked by validate():</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{findings.map((f, i) => <li key={i}><code>{f.path}</code> — {f.message}</li>)}</ul>
          </div>
        )}
        {diffHtml ? <div dangerouslySetInnerHTML={{ __html: diffHtml }} /> : <p style={S.muted}>Draft diff (old published → new draft) appears here.</p>}

        <h3 style={S.h3}>Audit log</h3>
        {state.audit.length === 0 && <p style={S.muted}>No edits yet.</p>}
        {state.audit.slice().reverse().map((a) => (
          <div key={a.id} style={{ fontSize: 12, color: "#444", padding: "2px 0", borderBottom: "1px solid #f0f0f0" }}>
            <code>{a.action}</code> {a.revision?.version ? `v${a.revision.version} ` : ""}
            {a.from && a.to ? <span style={S.muted}>({a.from} → {a.to})</span> : null} · {a.actor.name ?? a.actor.id}
          </div>
        ))}
      </section>
    </div>
  );
}

/**
 * A generic Theme editor: walks the whole Theme object and renders an input per leaf token
 * (number / colour / text / number[]) so every token is editable — not just a hand-picked few.
 */
function ThemeEditor({ theme, onChange, onReset }: { theme: Record<string, unknown>; onChange: (t: Record<string, unknown>) => void; onReset: () => void }) {
  const set = (path: string[], value: unknown) => {
    const next = structuredClone(theme);
    let node = next as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) node = node[path[i]!] as Record<string, unknown>;
    node[path[path.length - 1]!] = value;
    onChange(next);
  };
  return (
    <>
      {Object.entries(theme).map(([group, value]) => (
        <details key={group} style={S.group}>
          <summary style={S.summary}>{group}</summary>
          <div style={{ paddingTop: 8 }}>
            <Leaf label="" value={value} path={[group]} set={set} />
          </div>
        </details>
      ))}
      <button style={{ ...S.tab, marginTop: 6 }} onClick={onReset}>Reset theme</button>
    </>
  );
}

function Leaf({ label, value, path, set }: { label: string; value: unknown; path: string[]; set: (p: string[], v: unknown) => void }) {
  // Nested group (e.g. fontSize.title) — recurse.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (
      <>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <Leaf key={k} label={k} value={v} path={[...path, k]} set={set} />
        ))}
      </>
    );
  }
  // number[] (e.g. article.headingFontSize) — one number input per entry.
  if (Array.isArray(value)) {
    return (
      <Field label={label}>
        <div style={{ display: "flex", gap: 6 }}>
          {value.map((n, i) => (
            <input
              key={i}
              type="number"
              value={n as number}
              onChange={(e) => set(path, value.map((x, j) => (j === i ? Number(e.target.value) : x)))}
              style={{ ...S.input, width: 64 }}
            />
          ))}
        </div>
      </Field>
    );
  }
  if (typeof value === "number") {
    return <Field label={label}><input type="number" value={value} onChange={(e) => set(path, Number(e.target.value))} style={S.input} /></Field>;
  }
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
    // `<input type="color">` only round-trips 6-char #rrggbb; anything else falls through to text.
    return <Field label={label}><input type="color" value={value} onChange={(e) => set(path, e.target.value)} /></Field>;
  }
  // Enum tokens (alignment, page size) render as a <select>, detected by the current value.
  const options = ENUMS.find((o) => o.includes(value as string));
  if (typeof value === "string" && options) {
    return (
      <Field label={label}>
        <select value={value} onChange={(e) => set(path, e.target.value)} style={S.input}>
          {options.map((o) => <option key={o}>{o}</option>)}
        </select>
      </Field>
    );
  }
  // Any other free-form string.
  return <Field label={label}><input type="text" value={String(value)} onChange={(e) => set(path, e.target.value)} style={S.input} /></Field>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      {label && <div style={{ fontSize: 12, color: "#555", marginBottom: 3 }}>{label}</div>}
      {children}
    </label>
  );
}

function download(base64: string, name: string, mime: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#111" },
  muted: { color: "#666" },
  cols: { display: "grid", gridTemplateColumns: "360px 1fr", gap: 20, alignItems: "start" },
  panel: { border: "1px solid #ddd", borderRadius: 8, padding: 16 },
  preview: { border: "1px solid #ddd", borderRadius: 8, padding: 16, minHeight: 300, background: "#fff" },
  input: { width: "100%", padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4, boxSizing: "border-box" },
  tab: { padding: "6px 12px", border: "1px solid #ccc", borderRadius: 6, background: "#f6f6f6", cursor: "pointer" },
  tabOn: { padding: "6px 12px", border: "1px solid #111", borderRadius: 6, background: "#111", color: "#fff", cursor: "pointer" },
  primary: { marginTop: 10, padding: "8px 16px", border: "none", borderRadius: 6, background: "#0a7", color: "#fff", cursor: "pointer", fontWeight: 600 },
  secondary: { marginTop: 10, marginLeft: 8, padding: "8px 16px", border: "1px solid #0a7", borderRadius: 6, background: "#fff", color: "#0a7", cursor: "pointer", fontWeight: 600 },
  h3: { fontSize: 14, margin: "14px 0 8px" },
  badge: { fontSize: 11, padding: "1px 6px", borderRadius: 10, color: "#333" },
  group: { border: "1px solid #eee", borderRadius: 6, padding: "6px 10px", marginBottom: 6 },
  summary: { cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#333" },
  error: { whiteSpace: "pre-wrap", color: "#b00020", background: "#fff0f2", padding: 8, borderRadius: 4, marginTop: 10 },
};
