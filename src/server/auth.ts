import type { BunRequest, Server } from "bun";
import { z } from "zod";
import { fromBase64 } from "@/shared/crypto";
import { env } from "./env";
import { HttpError, parseBody } from "./http";
import { deriveHmacKey } from "./secret";

/**
 * Optional single-user login: MAILBACK_PASSWORD_HASH holds a Bun.password hash (argon2id or bcrypt),
 * as is or base64-encoded. Sessions are stateless signed cookies. The key is derived from the server
 * secret and the hash, so changing the password logs out every session.
 *
 * This only guards access to the API. Mail stays end-to-end encrypted with the vault passphrase either way.
 */

const COOKIE = "mailback_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** API routes reachable without a session. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/session", "/api/login", "/api/logout"]);

function loadPasswordHash(): string | null {
  const value = env.MAILBACK_PASSWORD_HASH?.trim();
  if (!value) return null;
  const hash = value.startsWith("$") ? value : new TextDecoder().decode(fromBase64(value));
  if (!/^\$(argon2(id|i|d)|2[aby]?)\$/.test(hash)) {
    throw new Error(
      "MAILBACK_PASSWORD_HASH is not a valid password hash. Create one with `bun run hash-password` and use " +
        "the base64 form in .env files (Bun expands `$` in .env values, even in quotes).",
    );
  }
  return hash;
}

const passwordHash = loadPasswordHash();
const sessionKey = passwordHash ? await deriveHmacKey("mailback session", passwordHash) : null;
if (!passwordHash) console.warn("⚠️  No MAILBACK_PASSWORD_HASH set: the web UI and API are open to anyone who can reach them.");

const encoder = new TextEncoder();

async function sign(payload: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", sessionKey!, encoder.encode(payload));
  return Buffer.from(signature).toString("base64url");
}

async function createSession(): Promise<string> {
  const payload = `v1.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
  return `${payload}.${await sign(payload)}`;
}

async function validSession(token: string | null): Promise<boolean> {
  if (!sessionKey || !token) return false;
  const match = /^(v1\.(\d+))\.([\w-]+)$/.exec(token);
  if (!match || Number(match[2]) * 1000 < Date.now()) return false;
  const signature = Buffer.from(match[3]!, "base64url");
  return crypto.subtle.verify("HMAC", sessionKey, signature, encoder.encode(match[1]!));
}

async function authenticated(req: BunRequest): Promise<boolean> {
  return !passwordHash || validSession(req.cookies.get(COOKIE));
}

// --- brute force throttling ---------------------------------------------------

const failures = new Map<string, { count: number; resetAt: number }>();

function clientAddress(req: Request, server: Server<unknown>): string {
  return server.requestIP(req)?.address ?? "unknown";
}

function checkThrottle(address: string) {
  const entry = failures.get(address);
  if (entry && entry.resetAt < Date.now()) failures.delete(address);
  else if (entry && entry.count >= MAX_FAILURES) {
    const minutes = Math.ceil((entry.resetAt - Date.now()) / 60_000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${minutes} min.`);
  }
}

function recordFailure(address: string) {
  const entry = failures.get(address) ?? { count: 0, resetAt: Date.now() + FAILURE_WINDOW_MS };
  entry.count++;
  failures.set(address, entry);
}

// --- routes -----------------------------------------------------------------

function cookieOptions(req: Request) {
  const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return { httpOnly: true, sameSite: "strict", secure, path: "/" } as const;
}

export const authRoutes = {
  "/api/session": async (req: BunRequest) =>
    Response.json({ required: !!passwordHash, authenticated: await authenticated(req) }),

  "/api/login": {
    async POST(req: BunRequest, server: Server<unknown>) {
      if (!passwordHash) return new Response(null, { status: 204 });
      const address = clientAddress(req, server);
      checkThrottle(address);
      const { password } = await parseBody(req, z.object({ password: z.string().min(1).max(1024) }));
      if (!(await Bun.password.verify(password, passwordHash))) {
        recordFailure(address);
        throw new HttpError(401, "Wrong password");
      }
      failures.delete(address);
      req.cookies.set(COOKIE, await createSession(), { ...cookieOptions(req), maxAge: SESSION_SECONDS });
      return new Response(null, { status: 204 });
    },
  },

  "/api/logout": {
    POST(req: BunRequest) {
      req.cookies.delete({ name: COOKIE, ...cookieOptions(req) });
      return new Response(null, { status: 204 });
    },
  },
};

// --- guarding the other routes ----------------------------------------------

type Handler = (req: BunRequest, server: Server<unknown>) => Response | Promise<Response>;

function guard(route: unknown): unknown {
  if (typeof route === "function") {
    const handler = route as Handler;
    return async (req: BunRequest, server: Server<unknown>) =>
      (await authenticated(req)) ? handler(req, server) : Response.json({ error: "Login required" }, { status: 401 });
  }
  if (route && typeof route === "object" && !(route instanceof Response)) {
    // { GET, POST, … } method handlers
    return Object.fromEntries(Object.entries(route).map(([method, handler]) => [method, guard(handler)]));
  }
  return route;
}

/** Require a session for all API routes except the public ones. The app bundle itself stays public. */
export function protect<T extends Record<string, unknown>>(routes: T): T {
  if (!passwordHash) return routes;
  return Object.fromEntries(
    Object.entries(routes).map(([path, route]) => [
      path,
      path.startsWith("/api/") && !PUBLIC_ROUTES.has(path) ? guard(route) : route,
    ]),
  ) as T;
}
