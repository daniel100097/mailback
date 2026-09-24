import type { BunRequest, Server } from "bun";
import { env } from "./env";

/**
 * MAILBACK_READ_ONLY: the UI and API can browse, search and export, but change nothing and never write to an
 * IMAP server (no restore, no account changes, no vault setup). Backup syncs keep running: they only read from IMAP.
 */
export const readOnlyMode = env.MAILBACK_READ_ONLY;
if (readOnlyMode) console.log("🔒 Read-only mode: restore, account changes and vault setup are disabled.");

/** API routes that may still be called with a write method in read-only mode. */
const ALLOWED_WRITES = new Set(["/api/login", "/api/logout", "/api/search-index", "/api/accounts/:id/sync"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Handler = (req: BunRequest, server: Server<unknown>) => Response | Promise<Response>;

const forbidden = () => Response.json({ error: "Mailback is in read-only mode" }, { status: 403 });

function blockWrites(route: unknown): unknown {
  if (typeof route === "function") {
    const handler = route as Handler;
    return (req: BunRequest, server: Server<unknown>) => (SAFE_METHODS.has(req.method) ? handler(req, server) : forbidden());
  }
  if (route && typeof route === "object" && !(route instanceof Response)) {
    // { GET, POST, … } method handlers
    return Object.fromEntries(
      Object.entries(route).map(([method, handler]) => [method, SAFE_METHODS.has(method) ? handler : forbidden]),
    );
  }
  return route;
}

/** In read-only mode, reject every API write except the allowed ones, so new routes are blocked automatically. */
export function readOnly<T extends Record<string, unknown>>(routes: T): T {
  if (!readOnlyMode) return routes;
  return Object.fromEntries(
    Object.entries(routes).map(([path, route]) => [
      path,
      path.startsWith("/api/") && !ALLOWED_WRITES.has(path) ? blockWrites(route) : route,
    ]),
  ) as T;
}
