import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Ambient declaration for `./api.mjs` (a plain, build-step-free ESM module — see its own header
 * comment for why). Restores a minimal compile-time net for `vite.config.ts` and `server.mjs`.
 */
export interface ApiHandler {
  /** Resolves `true` if `pathname` matched a route (the response has been written); `false` otherwise. */
  handle(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createApiHandler(options: { lib: unknown; catalogDir: string }): ApiHandler;
