/**
 * The "Edit before export" flow (PRD #147 / ADR-0014) — the first place the demo's **browser** imports
 * the library, through the browser-safe `@petrpus/legal-docs/edit` subpath.
 *
 * The server freezes a base Snapshot and hands over its tree (`/api/edit/start`); everything between
 * that and the export is client-side: an `EditSession` owns the op log, the preview/redline/review views
 * are the library's own Renderers, and the form below edits whatever block the preview was clicked on
 * (blocks address themselves with `data-path`). The export posts the **Edit set**, never a document —
 * the server is what turns it into an edited Snapshot, so no exported file exists without an audit
 * record. The re-render button proves the point: the stored Snapshot reproduces the export byte for byte.
 *
 * Two editors, one session: the **Write** view is the TipTap WYSIWYG (#159), which maps what it does to
 * the same ops; the form below the preview edits whatever block was clicked (or whatever block the
 * WYSIWYG caret is in). Neither owns any state — undo/redo, the op log and the comments are the
 * session's, which is why switching between them mid-edit changes nothing.
 */

import { useEffect, useReducer, useState } from "react";
import {
  createEditSession,
  formatTreePath,
  parseRichText,
  parseTreePath,
  richTextToMarkdown,
  type Align,
  type BlockIndent,
  type DocumentNode,
  type DocumentTree,
  type EditOp,
  type EditSession,
  type TreePath,
} from "@petrpus/legal-docs/edit";
import { DocumentEditor } from "./editor/Editor";
import type { Meta } from "./meta";
import { postJson } from "./meta";
import { Field, MIME, S, download } from "./ui";

type Format = "html" | "pdf" | "docx";
type View = "write" | "preview" | "redline" | "review" | "output";

const ALIGNMENTS: Align[] = ["left", "center", "right", "justify"];

/** An `/api/edit/*` failure, with the structure a rejected edit carries (op index, path, zod issues). */
interface ApiError {
  error?: string;
  opIndex?: number;
  path?: string;
  issues?: { path: (string | number)[]; message: string }[];
}

export function EditTab({ meta }: { meta: Meta }) {
  const [templateId, setTemplateId] = useState("parties");
  const [session, setSession] = useState<EditSession>();
  // The session is an external store: it notifies on every change and `session.tree` is a new
  // reference exactly when the document changed, so a bare counter is all the re-render this needs.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [view, setView] = useState<View>("write");
  const [selected, setSelected] = useState<TreePath>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [editedId, setEditedId] = useState<string>();
  /** The last HTML export, kept so the re-render can be compared against it byte for byte. */
  const [exportedHtml, setExportedHtml] = useState<string>();
  const [output, setOutput] = useState<{ title: string; html: string }>();

  useEffect(() => session?.subscribe(bump), [session]);

  const template = meta.templates.find((t) => t.id === templateId);

  async function start() {
    setBusy(true);
    setError("");
    setStatus("");
    setSelected(undefined);
    setEditedId(undefined);
    setExportedHtml(undefined);
    setOutput(undefined);
    setView("write");
    const res = await postJson<ApiError & { baseId: string; tree: DocumentTree; html: string }>("/edit/start", {
      template: templateId,
      variant: template?.variants?.[0],
      data: template?.data ?? {},
    });
    if (res.error) {
      setSession(undefined);
      setError(res.error);
    } else {
      // The base Snapshot's id travels with the session and is stamped on the Edit set it exports.
      setSession(createEditSession({ base: { id: res.baseId, tree: res.tree }, author: "Demo Editor" }));
      setStatus(`Base Snapshot ${res.baseId} — click a block in the preview to edit it.`);
    }
    setBusy(false);
  }

  /** Apply one op. A rejected edit is an ordinary answer shown next to the form, not an exception. */
  function run(op: EditOp) {
    if (!session) return;
    const result = session.apply(op);
    setError(result.ok ? "" : result.error.message);
    setStatus("");
  }

  async function exportAs(format: Format) {
    if (!session) return;
    setBusy(true);
    setError("");
    const res = await postJson<ApiError & { editedId: string; html?: string; base64?: string }>("/edit/export", {
      baseId: session.baseSnapshotId,
      edits: session.toEditSet(),
      format,
    });
    if (res.error) {
      setError(describe(res));
    } else {
      setEditedId(res.editedId);
      if (format === "html" && res.html !== undefined) {
        setExportedHtml(res.html);
        setOutput({ title: `Exported HTML · edited Snapshot ${res.editedId}`, html: res.html });
        setView("output");
      } else if (res.base64 !== undefined) {
        download(res.base64, `${templateId}-edited.${format}`, MIME[format]!);
      }
      setStatus(`Edited Snapshot ${res.editedId} stored next to its base.`);
    }
    setBusy(false);
  }

  /** Re-render a stored Snapshot through the ordinary `renderFromSnapshot` path. */
  async function rerender(id: string, label: string) {
    setBusy(true);
    setError("");
    const res = await postJson<ApiError & { html: string }>("/edit/rerender", { id, format: "html" });
    if (res.error) {
      setError(res.error);
    } else {
      setOutput({ title: `${label} · Snapshot ${id}`, html: res.html });
      setView("output");
      const identical = exportedHtml !== undefined && res.html === exportedHtml;
      setStatus(
        id === editedId
          ? identical
            ? "Re-render of the edited Snapshot is byte-identical to the export ✓"
            : "Export an HTML first to compare the re-render against it."
          : "The base Snapshot still renders the original document.",
      );
    }
    setBusy(false);
  }

  function selectFrom(event: React.MouseEvent<HTMLDivElement>) {
    const el = (event.target as HTMLElement).closest?.("[data-path]");
    const raw = el?.getAttribute("data-path");
    if (raw === null || raw === undefined) return;
    try {
      setSelected(parseTreePath(raw));
      setError("");
    } catch {
      // A deleted block in the redline is addressed by `data-base-path`; nothing to select.
    }
  }

  if (!session) {
    return (
      <div style={S.cols}>
        <section style={S.panel}>
          <p style={S.muted}>
            Generate a document, edit it as a human would, then export. The edit is frozen as an
            <strong> Edit set</strong> and replayed into an <strong>edited Snapshot</strong> — the export is
            that Snapshot&rsquo;s rendering.
          </p>
          <Field label="Template">
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={S.input}>
              {meta.templates.map((t) => <option key={t.id}>{t.id}</option>)}
            </select>
          </Field>
          <button style={S.primary} onClick={start} disabled={busy}>{busy ? "Generating…" : "Edit before export"}</button>
          {error && <pre style={S.error}>{error}</pre>}
        </section>
        <section style={S.preview}>
          <p style={S.muted}>The generated document appears here, block by block.</p>
        </section>
      </div>
    );
  }

  const node = selected ? session.getNode(selected) : undefined;
  const selectedKey = selected ? formatTreePath(selected) : "";
  // The Write view is the editor itself; the other three are the library's Renderers over the same tree.
  const html =
    view === "write" ? "" :
    view === "redline" ? session.redlineHtml() :
    view === "review" ? session.reviewHtml() :
    view === "output" ? (output?.html ?? "") :
    session.preview();

  return (
    <div style={S.cols}>
      <section style={S.panel}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <button style={S.tab} onClick={() => session.undo()} disabled={!session.canUndo}>↶ Undo</button>
          <button style={S.tab} onClick={() => session.redo()} disabled={!session.canRedo}>↷ Redo</button>
          <button style={S.tab} onClick={start} disabled={busy}>Restart</button>
        </div>
        <p style={{ ...S.muted, fontSize: 12 }}>
          {session.cursor} op{session.cursor === 1 ? "" : "s"} applied{session.dirty ? "" : " (unedited)"} · base {session.baseSnapshotId}
        </p>

        <h3 style={S.h3}>Selected block {selectedKey && <code>{selectedKey}</code>}</h3>
        {!selected && <p style={S.muted}>Click a block in the preview.</p>}
        {selected && !node && <ListItemForm path={selected} run={run} onDeselect={() => setSelected(undefined)} />}
        {selected && node && (
          <>
            <NodeForm node={node} path={selected} run={run} />
            <BlockActions node={node} path={selected} session={session} run={run} onRemoved={() => setSelected(undefined)} />
          </>
        )}

        <h3 style={S.h3}>Comments</h3>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Note on the selected block"
            style={S.input}
          />
          <button
            style={S.tab}
            disabled={!selected || commentText.trim() === ""}
            onClick={() => {
              if (!selected) return;
              try {
                session.addComment({ path: selected, text: commentText.trim() });
                setCommentText("");
                setView("review");
              } catch (e) {
                // An anchor that addresses nothing is refused by `locate`, with the reason.
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Add
          </button>
        </div>
        {session.comments.map((c) => (
          <div key={c.id} style={{ fontSize: 12, borderBottom: "1px solid #f0f0f0", padding: "4px 0" }}>
            <code>{c.path ? formatTreePath(c.path) : "orphaned"}</code>{" "}
            <span style={{ textDecoration: c.resolved ? "line-through" : undefined }}>{c.text}</span>
            <button style={{ ...S.tab, padding: "0 6px", marginLeft: 6 }} onClick={() => session.resolveComment(c.id, !c.resolved)}>
              {c.resolved ? "reopen" : "resolve"}
            </button>
            <button style={{ ...S.tab, padding: "0 6px", marginLeft: 4 }} onClick={() => session.removeComment(c.id)}>×</button>
          </div>
        ))}

        <h3 style={S.h3}>Export</h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["html", "pdf", "docx"] as Format[]).map((f) => (
            <button key={f} style={S.tab} onClick={() => exportAs(f)} disabled={busy}>{f.toUpperCase()}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <button style={S.tab} disabled={!editedId || busy} onClick={() => editedId && rerender(editedId, "Re-rendered edited Snapshot")}>
            Re-render edited Snapshot
          </button>
          <button style={S.tab} disabled={busy} onClick={() => session.baseSnapshotId && rerender(session.baseSnapshotId, "Re-rendered base Snapshot")}>
            Re-render base
          </button>
        </div>
        {error && <pre style={S.error}>{error}</pre>}
        {status && <p style={S.ok}>{status}</p>}
      </section>

      <section style={S.preview}>
        <nav style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button style={view === "write" ? S.tabOn : S.tab} onClick={() => setView("write")}>Write</button>
          <button style={view === "preview" ? S.tabOn : S.tab} onClick={() => setView("preview")}>Preview</button>
          <button style={view === "redline" ? S.tabOn : S.tab} onClick={() => setView("redline")}>Redline</button>
          <button style={view === "review" ? S.tabOn : S.tab} onClick={() => setView("review")}>Review</button>
          {output && <button style={view === "output" ? S.tabOn : S.tab} onClick={() => setView("output")}>{output.title.split(" · ")[0]}</button>}
        </nav>
        {view === "output" && output && <p style={{ ...S.muted, fontSize: 12 }}>{output.title}</p>}
        <style>{`.edit-preview [data-path]{cursor:pointer}.edit-preview [data-path]:hover{outline:1px dashed #0a7}${selectedKey ? `.edit-preview [data-path="${selectedKey}"]{outline:2px solid #0a7;background:#f3fffa}` : ""}`}</style>
        {view === "write" ? (
          <DocumentEditor session={session} onSelect={setSelected} onError={setError} />
        ) : (
          /* Safe for the same reason the Render tab's preview is — see the demo README's safety note. */
          <div className="edit-preview" onClick={selectFrom} dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </section>
    </div>
  );
}

/** The per-kind form — one field per editable leaf of the selected node (the `locate` table). */
function NodeForm({ node, path, run }: { node: DocumentNode; path: TreePath; run: (op: EditOp) => void }) {
  const at = (...keys: (string | number)[]): TreePath => [...path, ...keys];
  const text = (p: TreePath, value: string | null) => run({ op: "setText", path: p, value });
  const optional = (p: TreePath) => (v: string) => text(p, v === "" ? null : v);

  switch (node.kind) {
    case "title":
    case "paragraph":
      return (
        <>
          <Field label="text"><TextInput multiline value={node.text} onCommit={(v) => text(at("text"), v)} /></Field>
          <Field label="align (per-block override, ADR-0008)">
            <select
              value={node.align ?? ""}
              onChange={(e) => run({ op: "setStyle", path: at("align"), value: e.target.value === "" ? null : (e.target.value as Align) })}
              style={S.input}
            >
              <option value="">(theme default)</option>
              {ALIGNMENTS.map((a) => <option key={a}>{a}</option>)}
            </select>
          </Field>
          <IndentField value={node.indent} onCommit={(v) => run({ op: "setStyle", path: at("indent"), value: v })} />
        </>
      );
    case "richText":
      return (
        <Field label="rich text — markdown subset (**bold**, *italic*, blank line = new paragraph)">
          <TextInput
            multiline
            value={richTextToMarkdown(node.value)}
            onCommit={(v) => run({ op: "setRichText", path: at("value"), value: parseRichText(v) })}
          />
        </Field>
      );
    case "article":
      return (
        <>
          <p style={{ ...S.muted, fontSize: 12 }}>
            Article <strong>{node.no}</strong>, level {node.level} — numbering is assigned during assembly
            and is not editable. Click a block inside the article to edit it.
          </p>
          <Field label="heading (optional)"><TextInput value={node.heading ?? ""} onCommit={optional(at("heading"))} /></Field>
        </>
      );
    case "numberedList":
    case "bulletList":
    case "alphaList":
      return (
        <>
          <p style={{ ...S.muted, fontSize: 12 }}>{node.items.length} item(s) — click an item in the preview to edit or remove it.</p>
          <button
            style={S.tab}
            onClick={() => run({ op: "insertListItem", path: at("items", node.items.length), item: [{ kind: "paragraph", text: "New item." }] })}
          >
            + Add item
          </button>
        </>
      );
    case "partyHeader":
      return (
        <>
          <Field label="role label"><TextInput value={node.roleLabel} onCommit={(v) => text(at("roleLabel"), v)} /></Field>
          <Field label="name"><TextInput value={node.party.name} onCommit={(v) => text(at("party", "name"), v)} /></Field>
          <Field label="id number (optional)"><TextInput value={node.party.idNumber ?? ""} onCommit={optional(at("party", "idNumber"))} /></Field>
          <Field label="address (optional)"><TextInput value={node.party.address ?? ""} onCommit={optional(at("party", "address"))} /></Field>
          {node.party.kind && <p style={{ ...S.muted, fontSize: 12 }}>kind: {node.party.kind} (fixed by the generated document)</p>}
        </>
      );
    case "keyValueTable":
      return (
        <>
          {node.rows.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 6 }}>
              <TextInput value={row.label} onCommit={(v) => text(at("rows", i, "label"), v)} />
              <TextInput value={row.value} onCommit={(v) => text(at("rows", i, "value"), v)} />
            </div>
          ))}
          <p style={{ ...S.muted, fontSize: 12 }}>Rows are edited cell by cell; replace the node to change their number.</p>
        </>
      );
    case "signatures":
      return (
        <>
          {node.places.map((place, i) => (
            <div key={i} style={{ display: "flex", gap: 6 }}>
              <TextInput value={place.name} onCommit={(v) => text(at("places", i, "name"), v)} />
              <TextInput value={place.role ?? ""} onCommit={optional(at("places", i, "role"))} />
            </div>
          ))}
        </>
      );
    case "custom":
      return (
        <p style={{ ...S.muted, fontSize: 12 }}>
          Custom block <code>{node.component}</code> — opaque to editing (ADR-0005). It can be removed or
          moved, never edited or inserted.
        </p>
      );
  }
}

/** Structural actions on the selected node. Articles are deliberately not movable (out of scope). */
function BlockActions({ node, path, session, run, onRemoved }: { node: DocumentNode; path: TreePath; session: EditSession; run: (op: EditOp) => void; onRemoved: () => void }) {
  const index = path[path.length - 1];
  if (typeof index !== "number") return null;
  const siblings = path.slice(0, -1);
  // `moveNode`'s destination is read against the tree AFTER the removal, so moving down past the last
  // position would be out of range — ask the tree whether there is a next sibling at all.
  const hasNext = session.getNode([...siblings, index + 1]) !== undefined;
  const move = (to: number) => run({ op: "moveNode", from: path, to: [...siblings, to] });
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
      {node.kind !== "article" && (
        <>
          <button style={S.tab} disabled={index === 0} onClick={() => move(index - 1)}>↑ Move up</button>
          <button style={S.tab} disabled={!hasNext} onClick={() => move(index + 1)}>↓ Move down</button>
        </>
      )}
      <button style={S.tab} onClick={() => run({ op: "insertNode", path: [...siblings, index + 1], node: { kind: "paragraph", text: "New paragraph." } })}>
        + Paragraph after
      </button>
      <button style={S.tab} onClick={() => { run({ op: "removeNode", path }); onRemoved(); }}>🗑 Remove</button>
    </div>
  );
}

/** A selected `<li>`: the path addresses a list item (a node list), not a node. */
function ListItemForm({ path, run, onDeselect }: { path: TreePath; run: (op: EditOp) => void; onDeselect: () => void }) {
  const index = path[path.length - 1];
  if (path[path.length - 2] !== "items" || typeof index !== "number") {
    return <p style={S.muted}>Nothing editable at this path.</p>;
  }
  return (
    <>
      <p style={{ ...S.muted, fontSize: 12 }}>List item {index + 1} — click a block inside it to edit its text.</p>
      <div style={{ display: "flex", gap: 6 }}>
        <button style={S.tab} onClick={() => run({ op: "insertListItem", path: [...path.slice(0, -1), index + 1], item: [{ kind: "paragraph", text: "New item." }] })}>
          + Item after
        </button>
        <button style={S.tab} onClick={() => { run({ op: "removeListItem", path }); onDeselect(); }}>🗑 Remove item</button>
      </div>
    </>
  );
}

/**
 * `indent` is one `setStyle` op over the whole override (a partial value replaces it), so both numbers
 * are committed together — and on blur, like every other field, to keep one op per human edit.
 */
function IndentField({ value, onCommit }: { value: BlockIndent | undefined; onCommit: (v: BlockIndent | null) => void }) {
  const shown = (v: number | undefined) => (v === undefined ? "" : String(v));
  const [draft, setDraft] = useState({ left: shown(value?.left), firstLine: shown(value?.firstLine) });
  useEffect(() => setDraft({ left: shown(value?.left), firstLine: shown(value?.firstLine) }), [value]);
  const commit = () => {
    const next: BlockIndent = {};
    if (draft.left !== "") next.left = Number(draft.left);
    if (draft.firstLine !== "") next.firstLine = Number(draft.firstLine);
    if (next.left === value?.left && next.firstLine === value?.firstLine) return;
    onCommit(Object.keys(next).length === 0 ? null : next);
  };
  return (
    <Field label="indent — left / first line (pt, blank inherits)">
      <div style={{ display: "flex", gap: 6 }}>
        <input type="number" value={draft.left} onBlur={commit} onChange={(e) => setDraft({ ...draft, left: e.target.value })} style={S.input} />
        <input type="number" value={draft.firstLine} onBlur={commit} onChange={(e) => setDraft({ ...draft, firstLine: e.target.value })} style={S.input} />
      </div>
    </Field>
  );
}

/**
 * A text field that commits on blur (or Enter), not per keystroke — one op per edit keeps the op log
 * (and therefore the Edit set, the redline and undo) at the granularity a human would recognize.
 */
function TextInput({ value, onCommit, multiline }: { value: string; onCommit: (v: string) => void; multiline?: boolean }) {
  const [draft, setDraft] = useState(value);
  // Re-sync when the tree changed under the field — an undo, or another op touching the same leaf.
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const shared = { value: draft, onBlur: commit, style: S.input };
  return multiline ? (
    <textarea {...shared} rows={4} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input {...shared} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}

/** A rejected edit, with the op index the server reported. */
function describe(res: ApiError): string {
  if (res.issues?.length) return `${res.error}\n${res.issues.map((i) => `  ${i.path.join("/")}: ${i.message}`).join("\n")}`;
  return res.opIndex === undefined ? (res.error ?? "Unknown error") : `${res.error} (op ${res.opIndex})`;
}
