/**
 * A Clause reference binds a Clause to a template: either pinned (`id@v2`) or `id@latest`
 * (auto-newest). A bare `id` means `@latest`.
 */
import { LegalDocsError } from "./errors";
export interface ClauseRef {
  id: string;
  version: number | "latest";
}

export function parseClauseRef(ref: string): ClauseRef {
  const at = ref.lastIndexOf("@");
  if (at === -1) return { id: ref, version: "latest" };

  const id = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (id.length === 0) throw new LegalDocsError(`Invalid clause reference: "${ref}"`);
  if (version === "latest") return { id, version: "latest" };

  const match = /^v(\d+)$/.exec(version);
  if (!match) throw new LegalDocsError(`Invalid clause version in "${ref}" (use @vN or @latest)`);
  return { id, version: Number(match[1]) };
}
