# The Custom block escape-hatch contract

Special-layout documents (a landscape grid promissory note, a certificate with absolute positioning,
a multi-column form) cannot be expressed with the closed **Core node set**. The escape hatch is a
**Custom block**: a renderer-native implementation referenced from a template. This ADR fixes the
contract — its shape, where it lives, how props are typed and bound, and how it degrades — because it
is a public extension API that is expensive to change once consumers depend on it.

## Decision

**Shape (code-side, per-format).** A Custom block is a per-format record of render functions plus an
optional props schema:

```ts
interface CustomBlock {
  schema?: ZodType;                                   // optional props contract
  pdf: (props: unknown, ctx: { theme: Theme }) => ReactElement;  // required
  html?: ...;  // Phase 4
  docx?: ...;  // Phase 5
}
type CustomBlockRegistry = Record<string, CustomBlock>;
```

- `pdf` is **required**; `html`/`docx` are optional (added in later phases). A Custom block is a
  **leaf** — it renders its own complete layout, never core nodes. Its render context is `{ theme }`
  (deliberately minimal, extensible later).
  > **Amended (pre-0.1.0):** `pdf` is now **optional** too — all three slots are optional (register the
  > formats you render; a missing format degrades). This lets an HTML-only consumer author a block
  > without an unused react-pdf `pdf` impl. The PDF renderer already degraded a missing `pdf` at
  > runtime, so this only relaxes the type to match. Register at least one implementation.
- The registry is **code-side**, supplied via `renderDocument({ customBlocks })` and
  `validate({ customBlocks })` — the same pattern as `schemas` / `helpers` / `derivations` (ADR-0004).
  It is never Catalog content.

**Authoring & binding.** A template references a Custom block by name:
`custom: { component, props }` (a new body item). Tree assembly **deep-binds** `props` — `$`-paths are
substituted recursively, literals pass through — producing a `custom` DocumentNode
(`{ kind: "custom", component, props }`). Assembling an object of `$`-paths is **Binding**, not
computation; anything *computed* must still be a **Derivation** (`props: $derived.x`). The **engine
stays decoupled** from the registry: it builds the node without it, so core never imports
render-coupled code.

**Validation.** If a Custom block declares `schema`, its `props` are validated at **render dispatch**
(the renderer holds the registry) — not in the engine — and the impl receives the parsed value. The
integrity lint, given `customBlocks`, checks that every referenced `component` is registered and
typechecks **literal** props against the schema.

**Dispatch & degradation.** The renderer looks up `customBlocks[node.component]`:
- not registered → **hard error** (a config/authoring bug, also a lint finding);
- registered but missing the target format's impl → **Degradation contract** (engine default
  `placeholder`, overridable per `renderDocument({ degradation })`; `placeholder` emits a visible,
  logged marker, `throw` fails hard — never silent). Degradation is **render-time only**: the
  placeholder is emitted inline, there is no `placeholder` core node.
- impl present → called with `(props, { theme })`.

> **Amended (pre-0.1.0, #116):** this dispatch sequence (lookup → hard error → format check →
> schema validation → degradation) is implemented **once**, format-agnostically, in
> `dispatchCustomBlock` next to the registry — not per renderer. Each Renderer only wraps the
> result (or the degradation marker) in its native output type. Marker policy is unified: plain
> body text in the format's default paragraph style, escaped where the format requires (HTML).
> The "renderers share the contract, not code" principle (ADR-0006) covers the core-node
> visitors, which remain independent; this escape-hatch pre-dispatch was always one contract.

Because `pdf` is required, PDF output never degrades; the seam is built now as a runtime guard for
untyped callers and goes live for `html`/`docx` in Phases 4–5.

**Snapshot.** The `custom` DocumentNode's `props` are frozen in the Snapshot tree, so props must be
**JSON-serializable**. The *implementation* is code, not data, and is never frozen — so
`renderFromSnapshot(snapshot, { customBlocks })` needs the registry to re-render a tree containing
custom nodes, **even in `full`/`tree` mode**. This is consistent with re-render always depending on
renderer code (the Custom-block registry is part of "the renderer").

## Consequences

- New `custom` kind in the Core node set and a `custom` body item; the PDF visitor gains a dispatch
  case (the exhaustive `never` default forces every renderer to handle it).
- `renderDocument` / `renderFromSnapshot` / `validate` gain a `customBlocks` input; `renderDocument`
  gains a `degradation` option (default `placeholder`).
- A tree with custom nodes is not self-contained for rendering without the code-side registry — an
  accepted asymmetry versus catalog-immune core-only trees.
- Alternatives rejected: storing impls in the Catalog (couples authored content to render code);
  validating props in the engine (couples core to the render-coupled registry); shallow props binding
  (forces a Derivation for every structured props object).
