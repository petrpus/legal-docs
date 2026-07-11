# Recipe: an LLM drafts a clause revision

The runtime editing API (ADR-0009) already has the right seam for this — an LLM is just another
producer of draft content. It calls `catalog.editing.createDraft(...)` exactly as a human editor's UI
would, and the existing **`validate()`-gated publish** is the guardrail: a bad draft (from a person or
a model) is blocked with structured findings, not merged. No code in this repo changes for this — the
library stays free of any AI/HTTP dependency.

## The flow

1. **LLM produces clause text.** You prompt it for a wording change; parse the response into the
   library's `Clause` shape (`{ clause, version, locale, vars, text }`).
2. **`createDraft`** — the LLM's output becomes a draft revision, invisible to `@latest` until
   published.
3. **`previewDiff` + `renderClauseDiff`** — a human reviews the old→new diff before it goes anywhere
   near production.
4. **`publish`**, inside a `try/catch` on `PublishValidationError` — if the draft would break a
   consuming template (unresolved var, composition break, …), the findings come back structured. Feed
   them to the LLM for another pass, or to the human reviewer.

```
LLM → ElementContent (clause) → createDraft → previewDiff (human review)
                                                       │
                                                       ▼
                                          publish ──► validate() gate
                                                       │            │
                                                    ok │            │ PublishValidationError
                                                       ▼            ▼
                                                  @latest advances   findings → LLM/human, retry
```

## Code

Uses `@anthropic-ai/sdk` — **the consumer's own dependency**, not part of `@petrpus/legal-docs`.

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  Catalog,
  MemoryEditableCatalogStore,
  PublishValidationError,
  renderClauseDiff,
  type Actor,
  type Clause,
} from "@petrpus/legal-docs";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

// Any EditableCatalogStore works here — MemoryEditableCatalogStore for this example,
// or a persistent adapter (e.g. adapters/sqlite/) in production.
const catalog = Catalog.fromStore(new MemoryEditableCatalogStore(seed));
const actor: Actor = { id: "llm-drafter", name: "Claude (drafting assistant)" };

async function draftClauseRevision(clauseId: string, instruction: string): Promise<Clause> {
  const current = await catalog.getClause(`${clauseId}@latest`, "en");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system:
      "You revise legal clause text. Return ONLY the revised clause body — no preamble, no markdown " +
      "fences, no commentary. Preserve any {{ variable }} placeholders exactly as they appear.",
    messages: [
      {
        role: "user",
        content: `Current text:\n${current.text}\n\nRevision instruction: ${instruction}`,
      },
    ],
  });

  const text = response.content.find((block) => block.type === "text")?.text ?? "";
  return { clause: clauseId, version: current.version + 1, locale: "en", vars: current.vars, text };
}

async function draftAndReview(clauseId: string, instruction: string) {
  const revised = await draftClauseRevision(clauseId, instruction);

  const handle = await catalog.editing.createDraft({
    ref: { kind: "clause", id: clauseId },
    content: { kind: "clause", clause: revised },
    actor,
  });

  // Human-reviewable diff before anything is published.
  const diff = await catalog.editing.previewDiff(handle.draft, { locale: "en" });
  console.log(renderClauseDiff(diff)); // render this HTML in a review UI

  await catalog.editing.submitForReview(handle.draft, actor);

  try {
    const published = await catalog.editing.publish(handle.draft, actor);
    console.log(`Published ${clauseId}@${published.version}`);
  } catch (err) {
    if (err instanceof PublishValidationError) {
      // Structured findings — feed back to the LLM for another attempt, or surface to a human.
      console.error("Publish blocked:", err.findings.map((f) => `${f.path}: ${f.message}`));
      return;
    }
    throw err;
  }
}
```

## Why this is safe by construction

- **Drafts are invisible to `@latest`** until published (ADR-0009) — a bad LLM draft never reaches a
  document render just by existing.
- **`publish` re-validates the whole catalog** as if the draft were live (`validate()` over a
  draft-as-published overlay) — a wording change that breaks a consuming template's `vars` binding, or
  a variant composition, is caught before anything ships. This is the same gate a human editor's draft
  goes through; the LLM gets no special treatment or bypass.
- **The findings are structured** (`ValidationFinding[]`, `{ path, message }`), not free text — easy to
  either hand back to the LLM as a targeted correction prompt or show a human reviewer.
- **`previewDiff`/`renderClauseDiff`** give a human a concrete old→new comparison before publish, not
  just trust in the model's output.

## What this repo intentionally doesn't provide

No HTTP server, no LLM SDK, no drafting endpoint — `catalog.editing` is a library API, not a service.
Wire it into whatever review surface fits your application (a Slack approval flow, an internal admin
UI, a CLI prompt). The demo's [Editor tab](../../examples/demo/) shows a *human*-driven version of the
same `createDraft → previewDiff → publish` flow if you want a UI reference to adapt.
