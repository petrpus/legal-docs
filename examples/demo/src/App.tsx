import { useEffect, useState } from "react";

type Format = "html" | "pdf" | "docx";

interface Meta {
  templates: string[];
  locales: string[];
  defaultTheme: Record<string, unknown>;
  diff: { clause: string; from: number; to: number };
  dataTemplates: Record<string, unknown>;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function App() {
  const [meta, setMeta] = useState<Meta>();
  const [tab, setTab] = useState<"render" | "diff">("render");

  useEffect(() => {
    fetch("/api/meta").then((r) => r.json()).then(setMeta);
  }, []);

  if (!meta) return <main style={S.page}>Loading…</main>;

  return (
    <main style={S.page}>
      <h1 style={{ margin: 0 }}>@petrpus/legal-docs — demo</h1>
      <p style={S.muted}>
        Live theme / locale / format over the sample catalog, plus a Clause diff. Rendering runs in the
        dev server (Node); the browser shows the HTML or downloads the PDF/DOCX.
      </p>
      <nav style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button style={tab === "render" ? S.tabOn : S.tab} onClick={() => setTab("render")}>Render</button>
        <button style={tab === "diff" ? S.tabOn : S.tab} onClick={() => setTab("diff")}>Clause diff</button>
      </nav>
      {tab === "render" ? <RenderTab meta={meta} /> : <DiffTab meta={meta} />}
    </main>
  );
}

function RenderTab({ meta }: { meta: Meta }) {
  const [template, setTemplate] = useState("agreement");
  const [locale, setLocale] = useState("en");
  const [format, setFormat] = useState<Format>("html");
  const [theme, setTheme] = useState(meta.defaultTheme);
  const [dataText, setDataText] = useState("{}");
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const needsData = template === "greeting";
  useEffect(() => {
    setDataText(needsData ? JSON.stringify(meta.dataTemplates[template] ?? {}, null, 2) : "{}");
  }, [template, needsData, meta]);

  async function render() {
    setBusy(true);
    setError("");
    try {
      const data = needsData ? JSON.parse(dataText) : {};
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, locale, theme, format, data }),
      }).then((r) => r.json());
      if (res.error) {
        setError(res.error);
        setHtml("");
      } else if (format === "html") {
        setHtml(res.html);
      } else {
        download(res.base64, `${template}.${format}`, MIME[format]!);
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
          <select value={template} onChange={(e) => setTemplate(e.target.value)} style={S.input}>
            {meta.templates.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
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
            <textarea value={dataText} onChange={(e) => setDataText(e.target.value)} rows={6} style={{ ...S.input, fontFamily: "monospace" }} />
          </Field>
        )}
        <h3 style={S.h3}>Theme</h3>
        <ThemeEditor theme={theme} onChange={setTheme} onReset={() => setTheme(meta.defaultTheme)} />
        <button style={S.primary} onClick={render} disabled={busy}>{busy ? "Rendering…" : "Render"}</button>
        {error && <pre style={S.error}>{error}</pre>}
      </section>
      <section style={S.preview}>
        {format === "html" ? (
          html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <p style={S.muted}>Render to preview the HTML here.</p>
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

function ThemeEditor({ theme, onChange, onReset }: { theme: Record<string, unknown>; onChange: (t: Record<string, unknown>) => void; onReset: () => void }) {
  // A few representative tokens; the full Theme has many more (see docs/THEMING.md).
  const set = (path: [string, string], value: unknown) => {
    const next = structuredClone(theme);
    (next[path[0]] as Record<string, unknown>)[path[1]] = value;
    onChange(next);
  };
  const num = (g: string, k: string) => (theme[g] as Record<string, number>)[k];
  const str = (g: string, k: string) => (theme[g] as Record<string, string>)[k];
  return (
    <>
      <Field label="Title size (pt)"><input type="number" value={num("fontSize", "title")} onChange={(e) => set(["fontSize", "title"], Number(e.target.value))} style={S.input} /></Field>
      <Field label="Paragraph size (pt)"><input type="number" value={num("fontSize", "paragraph")} onChange={(e) => set(["fontSize", "paragraph"], Number(e.target.value))} style={S.input} /></Field>
      <Field label="Text colour"><input type="color" value={str("color", "text")} onChange={(e) => set(["color", "text"], e.target.value)} /></Field>
      <Field label="Table border colour"><input type="color" value={str("table", "borderColor")} onChange={(e) => set(["table", "borderColor"], e.target.value)} /></Field>
      <Field label="Signature role colour"><input type="color" value={str("signatures", "roleColor")} onChange={(e) => set(["signatures", "roleColor"], e.target.value)} /></Field>
      <button style={S.tab} onClick={onReset}>Reset theme</button>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: "#555", marginBottom: 3 }}>{label}</div>
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
  cols: { display: "grid", gridTemplateColumns: "340px 1fr", gap: 20, alignItems: "start" },
  panel: { border: "1px solid #ddd", borderRadius: 8, padding: 16 },
  preview: { border: "1px solid #ddd", borderRadius: 8, padding: 16, minHeight: 300, background: "#fff" },
  input: { width: "100%", padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4, boxSizing: "border-box" },
  tab: { padding: "6px 12px", border: "1px solid #ccc", borderRadius: 6, background: "#f6f6f6", cursor: "pointer" },
  tabOn: { padding: "6px 12px", border: "1px solid #111", borderRadius: 6, background: "#111", color: "#fff", cursor: "pointer" },
  primary: { marginTop: 10, padding: "8px 16px", border: "none", borderRadius: 6, background: "#0a7", color: "#fff", cursor: "pointer", fontWeight: 600 },
  h3: { fontSize: 14, margin: "14px 0 8px" },
  error: { whiteSpace: "pre-wrap", color: "#b00020", background: "#fff0f2", padding: 8, borderRadius: 4, marginTop: 10 },
};
