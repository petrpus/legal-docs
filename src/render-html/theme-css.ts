import type { Theme } from "../render-pdf/theme";

/**
 * Generate one scoped stylesheet from the shared Theme. Every rule is scoped under `.legal-doc` so the
 * fragment can be embedded without leaking styles. Numeric tokens map to `px`, colors pass through.
 */
export function themeCss(t: Theme): string {
  const [h1, h2, h3] = t.article.headingFontSize;
  // `list.markerGap` is intentionally unused: HTML uses native <ol>/<ul> markers, not a manual gap.
  return [
    `.legal-doc{color:${t.color.text};font-family:serif;font-size:${t.fontSize.paragraph}px;}`,
    `.legal-doc .title{font-size:${t.fontSize.title}px;font-weight:bold;margin:0 0 ${t.spacing.title}px;text-align:${t.align.title};}`,
    // Paragraph defaults incl. block indent (left margin) and first-line indent; a per-block override
    // emits an inline style that wins over this rule (ADR-0008).
    `.legal-doc p{margin:0 0 ${t.spacing.paragraph}px ${t.indent.block}px;text-align:${t.align.paragraph};text-indent:${t.indent.firstLine}px;}`,
    `.legal-doc .article{margin-bottom:${t.article.gap}px;}`,
    `.legal-doc .article[data-level="2"],.legal-doc .article[data-level="3"]{margin-left:${t.article.indentPerLevel}px;}`,
    `.legal-doc .article__heading{font-weight:bold;margin-bottom:${t.spacing.paragraph}px;}`,
    // Per-level heading size from the same token the PDF renderer uses, via a direct-child selector.
    `.legal-doc .article[data-level="1"]>.article__heading{font-size:${h1}px;}`,
    `.legal-doc .article[data-level="2"]>.article__heading{font-size:${h2}px;}`,
    `.legal-doc .article[data-level="3"]>.article__heading{font-size:${h3}px;}`,
    `.legal-doc .list{margin:0 0 ${t.list.gap}px ${t.list.indent}px;}`,
    `.legal-doc .list--alpha{list-style-type:lower-alpha;}`,
    `.legal-doc .party{margin-bottom:${t.partyHeader.gap}px;}`,
    `.legal-doc .party__role{font-weight:bold;font-size:${t.partyHeader.roleFontSize}px;}`,
    `.legal-doc .kv{border-collapse:collapse;border-top:1px solid ${t.table.borderColor};margin-bottom:${t.spacing.paragraph}px;}`,
    `.legal-doc .kv th,.legal-doc .kv td{border-bottom:1px solid ${t.table.borderColor};padding:${t.table.cellPadding}px;font-size:${t.table.fontSize}px;text-align:left;vertical-align:top;}`,
    `.legal-doc .kv th{width:${t.table.labelWidth}px;}`,
    `.legal-doc .signatures{display:flex;gap:${t.signatures.columnGap}px;margin-top:${t.signatures.gap}px;}`,
    `.legal-doc .sig{flex:1;}`,
    `.legal-doc .sig__line{border-top:${t.signatures.lineWidth}px solid ${t.signatures.lineColor};margin-top:${t.signatures.lineSpace}px;margin-bottom:4px;}`,
    `.legal-doc .sig__name{font-size:${t.signatures.fontSize}px;}`,
    `.legal-doc .sig__role{font-size:${t.signatures.fontSize}px;color:${t.signatures.roleColor};}`,
    `.legal-doc .legal-doc__unsupported{color:#b00020;font-style:italic;}`,
  ].join("");
}
