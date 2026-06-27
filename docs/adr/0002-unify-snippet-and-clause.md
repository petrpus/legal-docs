# Unify Snippet and Clause into a single `Clause` element

The plan listed **three** catalog element kinds — Block, Snippet, Clause — distinguishing Snippet
from Clause by length ("short repeated text" vs "longer versioned legal passage") and by content
model (plain-with-vars vs rich-text). Neither axis is a real type boundary: length is not a type,
and a one-line phrase is just a degenerate single-paragraph rich-text. Snippet and Clause otherwise
share everything — catalog-registered, `@vN`-versioned, locale-aware, typed `vars` payload,
referenced from templates, same store, same diff.

**Decision:** collapse Snippet and Clause into one catalog element kind named **Clause** (the
domain-native legal term; "Snippet" is a generic programming word and is now an alias to avoid). The
catalog therefore has **two** element kinds: **Block** (structure) and **Clause** (text). A Clause
always uses the rich-text content model (`RichTextV1`) with `{{placeholder}}` tokens; authoring may
accept a plain string for trivial clauses but it normalizes to the one content model. Text that is
specific to a single document and is neither reused nor independently versioned is **not** a catalog
element — it is written inline in the template and becomes a **DocumentNode** directly.

A template binds a Clause either **pinned** (`clause@vN`) or **`clause@latest`** (auto-uses the
newest published version, so an edit propagates to every template referencing it that way). The
document **Snapshot** always freezes the concrete version actually resolved, so `@latest`'s live
propagation does not compromise audit or deterministic re-render.

## Consequences

- The author never has to decide "is this a Snippet or a Clause?" — there is one text element.
- Renderers have a single text path (rich-text), not two.
- We lose the ability to *type*-distinguish a lightweight phrase from a heavyweight reviewed passage.
  If governance ever needs that (e.g. review levels), it is added as Clause **metadata** (a tag /
  `reviewLevel`), not as a second element kind.
- This deviates from `docs/PLAN.md`, which still names three kinds; the plan is superseded on this
  point by this ADR.
