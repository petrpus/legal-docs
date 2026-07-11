// Static doc-site generator: renders the repo's markdown documentation into a self-contained
// HTML site under docs/ (each page inlines its own CSS/JS, no external requests, ready to serve
// as-is — e.g. from GitHub Pages with source = /docs). Run: npm run docs:build
//
// Cross-doc links are rewritten to the generated site; anything outside the page manifest below
// (source files, LICENSE, directories) is rewritten to a github.com blob/tree URL instead, since a
// doc site can't serve arbitrary repo files.
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GITHUB = "https://github.com/petrpus/legal-docs";

// --- Page manifest: source (repo-root-relative) -> output (repo-root-relative, under docs/) ---
// ADRs, the design plan, and CONTRIBUTING stay in the repo (linked to on GitHub, via the resolveHref
// fallback below) but are deliberately off the public site: it introduces the project and documents
// usage for developers (incl. LLM-assisted drafting) and a live demo, not the internal design history.
const PAGES = [
  { src: "README.md", out: "docs/index.html", group: "start", label: "Home", order: 0 },
  { src: "docs/demo-src/live-demo.html", out: "docs/live-demo.html", group: "start", label: "Live demo", order: 1, raw: true },

  { src: "docs/ARCHITECTURE.md", out: "docs/ARCHITECTURE.html", group: "guide", label: "Architecture", order: 0 },
  { src: "docs/AUTHORING.md", out: "docs/AUTHORING.html", group: "guide", label: "Authoring guide", order: 1 },
  { src: "docs/CONTEXT.md", out: "docs/CONTEXT.html", group: "guide", label: "Glossary", order: 2 },
  { src: "docs/THEMING.md", out: "docs/THEMING.html", group: "guide", label: "Theming", order: 3 },

  { src: "docs/recipes/llm-drafting.md", out: "docs/recipes/llm-drafting.html", group: "recipes", label: "LLM clause drafting" },

  { src: "CHANGELOG.md", out: "docs/CHANGELOG.html", group: "project", label: "Changelog", order: 1 },
  { src: "examples/demo/README.md", out: "docs/demo.html", group: "project", label: "Full demo (server)", order: 2 },
  { src: "actions/validate/README.md", out: "docs/action-validate.html", group: "project", label: "GitHub Action", order: 3 },
];

const bySrc = new Map(PAGES.map((p) => [p.src, p]));

// --- Manifest completeness: PAGES is hand-maintained, not a directory scan — fail loud rather than
// silently drop a new doc off the site. CLAUDE.md is internal agent guidance, not a public doc; the ADRs,
// PLAN.md and CONTRIBUTING.md are deliberately kept out of the site (see the PAGES comment above) — all
// stay on GitHub via resolveHref's fallback, so are excluded here rather than registered as pages. ---
const EXCLUDED = new Set(["CLAUDE.md", "docs/PLAN.md", "CONTRIBUTING.md"]);
function assertManifestComplete() {
  const candidateDirs = [".", "docs", "docs/recipes"];
  const discovered = new Set();
  for (const dir of candidateDirs) {
    for (const name of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      if (name.isFile() && name.name.endsWith(".md")) discovered.add(path.join(dir, name.name).replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  discovered.add("examples/demo/README.md");
  discovered.add("actions/validate/README.md");
  for (const excluded of EXCLUDED) discovered.delete(excluded);

  const registered = new Set(PAGES.map((p) => p.src));
  const missing = [...discovered].filter((f) => !registered.has(f));
  if (missing.length > 0) {
    throw new Error(`docs-site: markdown file(s) not registered in PAGES: ${missing.join(", ")}`);
  }
  for (const src of registered) {
    if (!existsSync(path.join(REPO, src))) throw new Error(`docs-site: PAGES entry "${src}" does not exist on disk`);
  }
}
assertManifestComplete();

// --- GitHub-compatible heading slugger (matches how the source markdown's own #anchors were authored) ---
function plainText(raw) {
  return raw
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}
function makeSlugger() {
  const seen = new Map();
  return (raw) => {
    const base = slugify(plainText(raw)) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

// --- Link resolution: repo path (relative to a source file's dir) -> href in the generated site ---
function resolveHref(href, currentSrc, currentOut) {
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  const hashIdx = href.indexOf("#");
  const pathPart = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const hash = hashIdx === -1 ? "" : href.slice(hashIdx);
  if (!pathPart) return href;

  const srcDir = path.dirname(currentSrc);
  const resolved = path.normalize(path.join(srcDir, pathPart)).replace(/\\/g, "/").replace(/\/$/, "");

  // A bare directory link (e.g. "actions/validate/") whose directory's README.md is itself a
  // registered page — resolve to that page rather than out to GitHub, so the site stays self-contained.
  const target = bySrc.get(resolved) ?? bySrc.get(`${resolved}/README.md`);
  if (target) {
    if (target.out === currentOut) return hash || "#"; // self-link: stay on this page
    const rel = path.relative(path.dirname(currentOut), target.out).replace(/\\/g, "/");
    return (rel.startsWith(".") ? rel : `./${rel}`) + hash;
  }

  // Not one of our rendered pages — link out to the source on GitHub (blob for a file, tree for a dir).
  const abs = path.join(REPO, resolved);
  let isDir;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    isDir = !existsSync(abs) && !/\.[a-z0-9]+$/i.test(resolved); // best guess if it doesn't exist locally
    console.warn(`docs-site: "${resolved}" (linked from ${currentSrc}) doesn't exist on disk — guessing ${isDir ? "directory" : "file"}`);
  }
  return `${GITHUB}/${isDir ? "tree" : "blob"}/main/${resolved}${hash}`;
}

// --- Render one page's markdown to a body-only HTML fragment ---
function renderBody(page) {
  // A "raw" page (currently just the live demo) is hand-authored HTML, not markdown — passed through
  // verbatim. Its own links/script paths are already correct relative to its output location, so none
  // of the markdown link-rewriting below applies.
  if (page.raw) return readFileSync(path.join(REPO, page.src), "utf8");

  const md = readFileSync(path.join(REPO, page.src), "utf8");
  const slugger = makeSlugger();

  const renderer = new marked.Renderer();
  renderer.heading = function (tok) {
    const html = this.parser.parseInline(tok.tokens);
    const id = slugger(tok.text);
    return `<h${tok.depth} id="${id}">${html}</h${tok.depth}>\n`;
  };
  renderer.link = function (tok) {
    const html = this.parser.parseInline(tok.tokens);
    const resolved = resolveHref(tok.href, page.src, page.out).replace(/"/g, "&quot;");
    const isExternalHost = /^https?:\/\//i.test(resolved);
    const t = tok.title ? ` title="${tok.title.replace(/"/g, "&quot;")}"` : "";
    const rel = isExternalHost ? ` target="_blank" rel="noopener"` : "";
    return `<a href="${resolved}"${t}${rel}>${html}</a>`;
  };
  const defaultTable = renderer.table.bind(renderer);
  renderer.table = function (tok) {
    return `<div class="table-wrap">${defaultTable(tok)}</div>`;
  };

  return marked.parse(md, { renderer, gfm: true, breaks: false });
}

// --- Sidebar nav ---
function navHtml(currentOut) {
  const rel = (out) => {
    const r = path.relative(path.dirname(currentOut), out).replace(/\\/g, "/");
    return r.startsWith(".") ? r : `./${r}`;
  };
  const groupLabel = { start: "Start here", guide: "Developer reference", recipes: "Recipes", project: "Project" };
  return ["start", "guide", "recipes", "project"]
    .map((g) => {
      const items = PAGES.filter((p) => p.group === g).sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.num ?? "").localeCompare(b.num ?? ""),
      );
      const lis = items
        .map((p) => {
          const badge = p.num ? `<span class="nav-num">${p.num}</span>` : p.badge ? `<span class="nav-tag">${p.badge}</span>` : "";
          const active = p.out === currentOut ? ' class="active" aria-current="page"' : "";
          return `<li><a href="${rel(p.out)}"${active}>${badge}${p.label}</a></li>`;
        })
        .join("\n");
      return `<div class="nav-group"><h2>${groupLabel[g]}</h2><ul>${lis}</ul></div>`;
    })
    .join("\n");
}

const CSS = `
:root {
  --bg: #f6f5f2;
  --bg-raised: #ffffff;
  --ink: #1a1d29;
  --ink-soft: #52566b;
  --ink-faint: #82869c;
  --accent: #2f4e8c;
  --accent-soft: #e7ecf5;
  --line: #dfddd6;
  --code-bg: #ecebe4;
  --code-ink: #2c2f3d;
  --shadow: rgba(26, 29, 41, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161c; --bg-raised: #1b1e27; --ink: #e7e6e2; --ink-soft: #9da0b5; --ink-faint: #6b6f85;
    --accent: #8ca9e0; --accent-soft: #232b42; --line: #2b2e3a; --code-bg: #1e212b; --code-ink: #d9dbe6;
    --shadow: rgba(0, 0, 0, 0.35);
  }
}
:root[data-theme="dark"] {
  --bg: #14161c; --bg-raised: #1b1e27; --ink: #e7e6e2; --ink-soft: #9da0b5; --ink-faint: #6b6f85;
  --accent: #8ca9e0; --accent-soft: #232b42; --line: #2b2e3a; --code-bg: #1e212b; --code-ink: #d9dbe6;
  --shadow: rgba(0, 0, 0, 0.35);
}
:root[data-theme="light"] {
  --bg: #f6f5f2; --bg-raised: #ffffff; --ink: #1a1d29; --ink-soft: #52566b; --ink-faint: #82869c;
  --accent: #2f4e8c; --accent-soft: #e7ecf5; --line: #dfddd6; --code-bg: #ecebe4; --code-ink: #2c2f3d;
  --shadow: rgba(26, 29, 41, 0.06);
}
* { box-sizing: border-box; }
html { color-scheme: light dark; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif;
  font-size: 17px; line-height: 1.7; -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; }
a:hover { border-bottom-color: currentColor; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.shell { display: flex; align-items: flex-start; min-height: 100vh; }
.sidebar {
  flex: 0 0 272px; width: 272px; min-height: 100vh; background: var(--bg-raised);
  border-right: 1px solid var(--line); padding: 1.75rem 1.25rem 2rem; position: sticky; top: 0;
  align-self: flex-start; font-family: -apple-system, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
}
.brand {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  margin-bottom: 1.75rem; padding-bottom: 1.1rem; border-bottom: 1px solid var(--line);
}
.brand a { font-family: Georgia, serif; font-weight: 700; font-size: 0.95rem; color: var(--ink); letter-spacing: 0.01em; border-bottom: none; }
.theme-toggle {
  font: inherit; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
  background: var(--accent-soft); color: var(--accent); border: none; border-radius: 3px;
  padding: 0.3rem 0.55rem; cursor: pointer;
}
.theme-toggle:hover { filter: brightness(1.05); }
.nav-group { margin-bottom: 1.5rem; }
.nav-group h2 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-faint); font-weight: 600; margin: 0 0 0.5rem; }
.nav-group ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.nav-group a { display: flex; align-items: baseline; gap: 0.45rem; color: var(--ink-soft); font-size: 0.86rem; padding: 0.3rem 0.55rem; border-radius: 4px; border-bottom: none; line-height: 1.35; }
.nav-group a:hover { background: var(--accent-soft); color: var(--ink); }
.nav-group a.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.nav-num { font-variant-numeric: tabular-nums; font-family: ui-monospace, "SF Mono", "Cascadia Code", monospace; font-size: 0.72rem; color: var(--ink-faint); flex: 0 0 auto; }
.nav-tag { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-faint); border: 1px solid var(--line); border-radius: 3px; padding: 0.05rem 0.3rem; flex: 0 0 auto; }
.sidebar-footer { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
.sidebar-footer a { font-size: 0.8rem; color: var(--ink-faint); }
main { flex: 1 1 auto; min-width: 0; padding: 3rem 2rem 5rem; display: flex; justify-content: center; }
article { width: 100%; max-width: 42rem; }
.live-demo-callout {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
  margin: 0 0 2.2rem; padding: 0.9rem 1.2rem; border-radius: 8px; background: var(--accent-soft);
  border: 1px solid var(--line); font-family: -apple-system, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
}
.live-demo-callout p { margin: 0; font-size: 0.9rem; color: var(--ink-soft); }
.live-demo-callout a.cta {
  flex: 0 0 auto; font-size: 0.82rem; font-weight: 700; color: var(--bg-raised); background: var(--accent);
  padding: 0.45rem 0.95rem; border-radius: 5px; border-bottom: none; white-space: nowrap;
}
.live-demo-callout a.cta:hover { filter: brightness(1.08); }
article h1 { font-size: 2.1rem; line-height: 1.2; margin: 0 0 1.75rem; text-wrap: balance; letter-spacing: -0.01em; }
article h2 { font-size: 1.45rem; margin: 2.6rem 0 1rem; padding-top: 0.4rem; border-top: 1px solid var(--line); text-wrap: balance; }
article h2:first-child { border-top: none; padding-top: 0; margin-top: 0; }
article h3 { font-size: 1.12rem; margin: 1.8rem 0 0.7rem; text-wrap: balance; }
article h4 { font-size: 0.98rem; margin: 1.4rem 0 0.5rem; font-weight: 700; }
article p, article ul, article ol { margin: 0 0 1.15rem; }
article ul, article ol { padding-left: 1.4rem; }
article li { margin-bottom: 0.35rem; }
article li > p { margin-bottom: 0.4rem; }
article strong { font-weight: 700; }
article em { font-style: italic; }
article blockquote { margin: 1.3rem 0; padding: 0.15rem 1.1rem; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 4px 4px 0; color: var(--ink-soft); }
article blockquote p:last-child { margin-bottom: 0; }
code { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace; font-size: 0.85em; background: var(--code-bg); color: var(--code-ink); padding: 0.1em 0.35em; border-radius: 3px; }
pre { margin: 1.3rem 0; padding: 1rem 1.2rem; background: var(--code-bg); border-left: 3px solid var(--line); border-radius: 0 5px 5px 0; overflow-x: auto; }
pre code { background: none; padding: 0; border-radius: 0; font-size: 0.85rem; line-height: 1.6; }
.table-wrap { overflow-x: auto; margin: 1.3rem 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; font-family: -apple-system, "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
th, td { text-align: left; padding: 0.5rem 0.85rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-faint); font-weight: 600; border-bottom: 1px solid var(--ink-faint); white-space: nowrap; }
tr:last-child td { border-bottom: none; }
hr { border: none; border-top: 1px solid var(--line); margin: 2.2rem 0; }
.page-footer { margin-top: 3.5rem; padding-top: 1.2rem; border-top: 1px solid var(--line); font-family: -apple-system, "Segoe UI", ui-sans-serif, system-ui, sans-serif; font-size: 0.78rem; color: var(--ink-faint); }
.nav-toggle { display: none; position: fixed; top: 0.85rem; left: 0.85rem; z-index: 20; width: 2.25rem; height: 2.25rem; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-raised); color: var(--ink); font-size: 1.1rem; cursor: pointer; box-shadow: 0 2px 8px var(--shadow); }
@media (max-width: 860px) {
  .nav-toggle { display: block; }
  .sidebar { position: fixed; z-index: 15; left: 0; top: 0; transform: translateX(-100%); transition: transform 0.18s ease; box-shadow: 0 0 24px var(--shadow); }
  .sidebar.open { transform: translateX(0); }
  main { padding: 4rem 1.25rem 3.5rem; }
  article h1 { font-size: 1.7rem; }
}
@media (prefers-reduced-motion: reduce) { .sidebar { transition: none; } }
`;

const SCRIPT = `
(function(){
  var stored = localStorage.getItem('legal-docs-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);
  function apply(mode){
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('legal-docs-theme', mode);
    document.querySelectorAll('[data-theme-label]').forEach(function(b){ b.textContent = mode === 'dark' ? 'Light' : 'Dark'; });
  }
  document.addEventListener('DOMContentLoaded', function(){
    var current = document.documentElement.getAttribute('data-theme');
    document.querySelectorAll('[data-theme-label]').forEach(function(b){
      b.textContent = current === 'dark' ? 'Light' : (current === 'light' ? 'Dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'Light' : 'Dark'));
      b.addEventListener('click', function(){
        var now = document.documentElement.getAttribute('data-theme');
        var isDark = now ? now === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
        apply(isDark ? 'light' : 'dark');
      });
    });
    var navToggle = document.querySelector('[data-nav-toggle]');
    var sidebar = document.querySelector('.sidebar');
    if (navToggle && sidebar) navToggle.addEventListener('click', function(){ sidebar.classList.toggle('open'); });
  });
})();
`;

function wrap(page, body) {
  const title = page.title === "@petrpus/legal-docs" ? page.title : `${page.title} — @petrpus/legal-docs`;
  const homeHref = path.relative(path.dirname(page.out), "docs/index.html").replace(/\\/g, "/") || "index.html";
  return `<!-- Generated by scripts/build-docs-site.mjs from ${page.src} — edit the source, then \`npm run docs:build\`. -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${page.description}" />
<style>${CSS}</style>
</head>
<body>
<button class="nav-toggle" data-nav-toggle aria-label="Toggle navigation">☰</button>
<div class="shell">
  <nav class="sidebar">
    <div class="brand">
      <a href="${homeHref}">@petrpus/legal-docs</a>
      <button class="theme-toggle" data-theme-label>Dark</button>
    </div>
    ${navHtml(page.out)}
    <div class="sidebar-footer"><a href="${GITHUB}" target="_blank" rel="noopener">GitHub ↗</a></div>
  </nav>
  <main>
    <article>
      ${body}
      <footer class="page-footer">MIT © Petr Puš — generated from the repository's markdown documentation.</footer>
    </article>
  </main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const liveDemoPage = bySrc.get("docs/demo-src/live-demo.html");

for (const page of PAGES) {
  let body = renderBody(page);
  if (page.src === "README.md" && liveDemoPage) {
    const href = path.relative(path.dirname(page.out), liveDemoPage.out).replace(/\\/g, "/");
    const callout = `<div class="live-demo-callout"><p>See it render: a genuinely interactive, in-browser demo — edit a payload, watch the document update, no server involved.</p><a class="cta" href="${href.startsWith(".") ? href : `./${href}`}">Try the live demo →</a></div>`;
    body = body.replace(/(<h1[^>]*>.*?<\/h1>\s*)/s, `$1${callout}`);
  }
  const title = page.src === "README.md" ? "@petrpus/legal-docs" : page.label;
  const description = `${page.label} — @petrpus/legal-docs documentation.`;
  const html = wrap({ ...page, title, description }, body);
  const outAbs = path.join(REPO, page.out);
  mkdirSync(path.dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, html, "utf8");
  console.log("wrote", page.out);
}
console.log(`\n${PAGES.length} pages generated into docs/.`);
