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
  ["A4", "LETTER"], // page.size
];

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
  const [templateId, setTemplateId] = useState("parties");
  const [variant, setVariant] = useState("");
  const [locale, setLocale] = useState("en");
  const [format, setFormat] = useState<Format>("html");
  const [theme, setTheme] = useState(meta.defaultTheme);
  const [dataText, setDataText] = useState("{}");
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const template = useMemo(() => meta.templates.find((t) => t.id === templateId), [meta, templateId]);
  const needsData = template?.data !== undefined;

  // Reset variant + prefill the sample payload whenever the template changes.
  useEffect(() => {
    setVariant(template?.variants?.[0] ?? "");
    setDataText(template?.data !== undefined ? JSON.stringify(template.data, null, 2) : "{}");
  }, [template]);

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
  h3: { fontSize: 14, margin: "14px 0 8px" },
  group: { border: "1px solid #eee", borderRadius: 6, padding: "6px 10px", marginBottom: 6 },
  summary: { cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#333" },
  error: { whiteSpace: "pre-wrap", color: "#b00020", background: "#fff0f2", padding: 8, borderRadius: 4, marginTop: 10 },
};
