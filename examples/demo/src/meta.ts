/** What `GET /api/meta` answers — the catalog the tabs drive their pickers from. */

export interface TemplateInfo {
  id: string;
  variants?: string[];
  data?: unknown;
}

export interface Meta {
  templates: TemplateInfo[];
  locales: string[];
  defaultTheme: Record<string, unknown>;
  diff: { clause: string; from: number; to: number };
}

/** POST JSON to an `/api/*` route. The handler answers a `{ error }` body with a 400 on any failure. */
export async function postJson<T>(path: string, body: unknown): Promise<T & { error?: string }> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T & { error?: string }>;
}
