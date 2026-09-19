/**
 * The WYSIWYG shell (#159): a TipTap editor over the E8 ProseMirror schema, bound to an `EditSession`
 * from the outside.
 *
 * The session stays the single source of truth. The editor is a *view* of `session.tree` that happens
 * to be typeable: every change it makes is debounced, mapped to Edit ops by `doc-ops.ts` and applied to
 * the session; everything the session does on its own (undo, redo, the form editor in the other pane, a
 * rejected op) is re-projected back into the editor. There is therefore exactly one history — the op
 * log — and the toolbar's undo/redo are the session's, not ProseMirror's (the `history` extension is
 * deliberately absent).
 *
 * The extensions are generated from `pm-schema.ts`'s own specs rather than restated, so the document the
 * editor holds is the one the round-trip property proves. Atoms (party, key/value table, signatures) get
 * React node views with a small form — they are not text and must not be typed into; a `custom` block is
 * opaque (ADR-0005) and shows as read-only; an article's number is a CSS decoration, never a character.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Editor as TiptapEditor, NodeViewProps, NodeViewRenderer } from "@tiptap/core";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { formatTreePath } from "@petrpus/legal-docs/edit";
import type {
  EditSession,
  KeyValueRow,
  PartyIdentification,
  SignaturePlace,
  TreePath,
} from "@petrpus/legal-docs/edit";
import { S } from "../ui";
import { isSyncedWith, syncSessionToDoc, treePathAt } from "./doc-ops";
import { treeToPmDoc } from "./pm-schema";
import { buildExtensions } from "./tiptap-extensions";

/** How long the editor may run ahead of the session. One op per pause, not one per keystroke. */
const FLUSH_MS = 400;

export interface DocumentEditorProps {
  session: EditSession;
  /** Told which block the caret is in, so the form editor's selection follows the cursor. */
  onSelect?: (path: TreePath | undefined) => void;
  /** Told about a refused change; `""` clears it. */
  onError?: (message: string) => void;
}

export function DocumentEditor({ session, onSelect, onError }: DocumentEditorProps) {
  const extensions = useMemo(() => buildExtensions(NODE_VIEWS), []);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Push the editor's document into the session; a refused change is reported and then undone by a re-projection. */
  const flush = useCallback(
    (active: TiptapEditor) => {
      pending.current = undefined;
      const { error } = syncSessionToDoc(session, active.state.doc);
      onError?.(error === undefined ? "" : error.message);
      if (error !== undefined) project(active, session, true);
    },
    [session, onError],
  );

  // Both take the editor as an argument: TipTap's callbacks are captured when the editor is created, so
  // a closure over the `editor` variable would be reading the `null` of that first render forever.
  const schedule = useCallback(
    (active: TiptapEditor) => {
      if (pending.current !== undefined) clearTimeout(pending.current);
      pending.current = setTimeout(() => flush(active), FLUSH_MS);
    },
    [flush],
  );

  const flushNow = useCallback(
    (active: TiptapEditor) => {
      if (pending.current !== undefined) clearTimeout(pending.current);
      flush(active);
    },
    [flush],
  );

  const editor = useEditor(
    {
      extensions,
      // JSON, not the node: `useEditor` builds the document itself, and the attrs (a party, a table's
      // rows, the parked furniture) travel by reference through `toJSON`, so nothing is flattened.
      content: treeToPmDoc(session.tree).toJSON(),
      // React renders the editor in an effect rather than during the render pass.
      immediatelyRender: false,
      editorProps: { attributes: { class: "pm-doc" } },
      onBlur: ({ editor: active }) => flushNow(active),
      onUpdate: ({ editor: active }) => schedule(active),
      onSelectionUpdate: ({ editor: active }) => onSelect?.(treePathAt(active.state.selection.$from)),
    },
    [session],
  );

  // Anything that moves the session without going through the editor — undo, redo, the form editor, the
  // toolbar below — leaves the two documents different, and the editor is the one that has to give way.
  useEffect(() => {
    if (!editor) return undefined;
    return session.subscribe(() => {
      // Never clobber text the human is still typing: that change is already on its way to the session.
      if (pending.current === undefined) project(editor, session, false);
    });
  }, [editor, session]);

  useEffect(() => () => { if (pending.current !== undefined) clearTimeout(pending.current); }, []);

  return (
    <div>
      <style>{EDITOR_CSS}</style>
      <Toolbar editor={editor} session={session} flush={flushNow} onError={onError} />
      <EditorContent editor={editor} />
      <p style={{ ...S.muted, fontSize: 12, marginTop: 8 }}>
        Every pause in typing becomes one Edit op. Structure (splitting, joining, deleting, list items)
        maps to insert/remove ops; the atoms below have their own small forms; article numbers are
        assigned during assembly and are not editable.
      </p>
    </div>
  );
}

/**
 * Re-render the editor from the session's tree, unless it already shows exactly that document. The
 * content goes in as JSON: TipTap derives its own instance of the mapped schema, and a node built under
 * `documentSchema` is a foreign node to it.
 */
function project(editor: TiptapEditor, session: EditSession, force: boolean) {
  if (!force && isSyncedWith(session, editor.state.doc)) return;
  editor.commands.setContent(treeToPmDoc(session.tree).toJSON(), { emitUpdate: false });
}

function Toolbar({
  editor,
  session,
  flush,
  onError,
}: {
  editor: TiptapEditor | null;
  session: EditSession;
  flush: (editor: TiptapEditor) => void;
  onError?: (message: string) => void;
}) {
  if (!editor) return null;
  // A local const, so the narrowing survives into the callbacks below.
  const active = editor;
  const path = treePathAt(active.state.selection.$from);
  const index = path?.[path.length - 1];
  const inList = path !== undefined && path[path.length - 2] === "items";
  // Articles are deliberately not movable (renumbering is out of scope), and a list item is not a node.
  const movable = path !== undefined && typeof index === "number" && !inList && session.getNode(path)?.kind !== "article";
  const siblings = path === undefined ? [] : path.slice(0, -1);

  /**
   * A structural command the editor cannot express as a step: it goes to the session, which re-projects.
   * Anything the human typed is flushed first, so the op lands on the document they are looking at.
   */
  function run(op: Parameters<EditSession["apply"]>[0]) {
    flush(active);
    const result = session.apply(op);
    onError?.(result.ok ? "" : result.error.message);
  }

  const move = (to: number) => {
    if (typeof index !== "number") return;
    run({ op: "moveNode", from: path as TreePath, to: [...siblings, to] });
  };

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
      {/* One history, and it is the session's: these step the op cursor, and the editor re-projects. */}
      <button style={S.tab} onClick={() => { flush(active); session.undo(); }} disabled={!session.canUndo}>↶ Undo</button>
      <button style={S.tab} onClick={() => { flush(active); session.redo(); }} disabled={!session.canRedo}>↷ Redo</button>
      <span style={{ width: 8 }} />
      {/* Marks exist only inside a `richText` clause — elsewhere the schema forbids them and these are off. */}
      <button style={S.tab} onClick={() => active.chain().focus().toggleMark("bold").run()} disabled={!active.can().toggleMark("bold")}>
        <strong>B</strong>
      </button>
      <button style={S.tab} onClick={() => active.chain().focus().toggleMark("italic").run()} disabled={!active.can().toggleMark("italic")}>
        <em>I</em>
      </button>
      <span style={{ width: 8 }} />
      <button
        style={S.tab}
        disabled={!movable || index === 0}
        onClick={() => typeof index === "number" && move(index - 1)}
      >
        ↑
      </button>
      <button
        style={S.tab}
        disabled={!movable || typeof index !== "number" || session.getNode([...siblings, index + 1]) === undefined}
        onClick={() => typeof index === "number" && move(index + 1)}
      >
        ↓
      </button>
      <span style={{ ...S.muted, fontSize: 12 }}>
        {path === undefined ? "no block" : <code>{formatTreePath(path)}</code>} · {session.cursor} op
        {session.cursor === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ node views: the atoms' forms */

function atomView(render: (props: NodeViewProps) => React.ReactNode): NodeViewRenderer {
  return ReactNodeViewRenderer((props: NodeViewProps) => (
    // `contentEditable={false}` is what keeps ProseMirror's keyboard out of these form fields.
    <NodeViewWrapper className="pm-atom" contentEditable={false}>
      {render(props)}
    </NodeViewWrapper>
  ));
}

function AtomInput({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  return (
    <input
      defaultValue={value}
      key={value}
      placeholder={placeholder}
      style={{ ...S.input, width: "auto", minWidth: 120, fontSize: 12 }}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
    />
  );
}

const NODE_VIEWS: Record<string, NodeViewRenderer> = {
  partyHeader: atomView(({ node, updateAttributes }) => {
    const party = node.attrs.party as PartyIdentification;
    const set = (patch: Partial<PartyIdentification>) => updateAttributes({ party: { ...party, ...patch } });
    return (
      <>
        <AtomInput value={node.attrs.roleLabel as string} onCommit={(v) => updateAttributes({ roleLabel: v })} />
        <AtomInput value={party.name} onCommit={(v) => set({ name: v })} />
        <AtomInput value={party.idNumber ?? ""} placeholder="id number" onCommit={(v) => set({ idNumber: v === "" ? undefined : v })} />
        <AtomInput value={party.address ?? ""} placeholder="address" onCommit={(v) => set({ address: v === "" ? undefined : v })} />
      </>
    );
  }),
  keyValueTable: atomView(({ node, updateAttributes }) => {
    const rows = node.attrs.rows as KeyValueRow[];
    const set = (i: number, patch: Partial<KeyValueRow>) =>
      updateAttributes({ rows: rows.map((row, j) => (i === j ? { ...row, ...patch } : row)) });
    return (
      <>
        {rows.map((row, i) => (
          <div key={i}>
            <AtomInput value={row.label} onCommit={(v) => set(i, { label: v })} />
            <AtomInput value={row.value} onCommit={(v) => set(i, { value: v })} />
          </div>
        ))}
      </>
    );
  }),
  signatures: atomView(({ node, updateAttributes }) => {
    const places = node.attrs.places as SignaturePlace[];
    const set = (i: number, patch: Partial<SignaturePlace>) =>
      updateAttributes({ places: places.map((place, j) => (i === j ? { ...place, ...patch } : place)) });
    return (
      <>
        {places.map((place, i) => (
          <div key={i}>
            <AtomInput value={place.name} onCommit={(v) => set(i, { name: v })} />
            <AtomInput value={place.role ?? ""} placeholder="role" onCommit={(v) => set(i, { role: v === "" ? undefined : v })} />
          </div>
        ))}
      </>
    );
  }),
  // Opaque by decision, not by omission: a custom block can be moved or removed, never edited.
  custom: atomView(({ node }) => (
    <span style={{ ...S.muted, fontSize: 12 }}>
      custom block <code>{node.attrs.component as string}</code> — read-only
    </span>
  )),
};

/** The editor's chrome. The markup it styles is `tiptap-extensions.ts`'s, and is never exported. */
const EDITOR_CSS = `
.pm-doc{outline:none;font-family:Georgia,"Times New Roman",serif;line-height:1.45;min-height:240px}
.pm-doc:focus{outline:none}
.pm-title{font-size:18px;font-weight:bold;margin:0 0 16px}
.pm-doc p{margin:0 0 8px}
.pm-article{margin-bottom:6px}
.pm-article::before{content:attr(data-no);float:left;margin-right:8px;font-weight:bold;color:#999}
.pm-article[data-level="2"],.pm-article[data-level="3"]{margin-left:14px}
.pm-heading{font-weight:bold;margin-bottom:8px}
.pm-list{margin:0 0 4px 18px}
.pm-list--alpha{list-style-type:lower-alpha}
.pm-rich{margin-bottom:8px}
.pm-atom{display:block;border:1px dashed #cfd8dc;border-radius:6px;padding:6px;margin-bottom:8px;background:#fafdff;font-family:system-ui,sans-serif}
.pm-atom input{margin:2px 4px 2px 0}
.ProseMirror-selectednode{outline:2px solid #0a7}
`;
