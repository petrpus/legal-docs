/** The bits of chrome every tab shares — the inline style sheet, a labelled field, and a download. */

export const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      {label && <div style={{ fontSize: 12, color: "#555", marginBottom: 3 }}>{label}</div>}
      {children}
    </label>
  );
}

export function download(base64: string, name: string, mime: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export const S: Record<string, React.CSSProperties> = {
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
  ok: { color: "#076", background: "#effaf5", padding: 8, borderRadius: 4, marginTop: 10 },
};
