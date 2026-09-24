import { serve } from "bun";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import index from "./index.html";
import { authRoutes, protect } from "./server/auth";
import { db } from "./server/db";
import { env } from "./server/env";
import { errorResponse } from "./server/http";
import { accountRoutes } from "./server/routes/accounts";
import { mailRoutes } from "./server/routes/mail";
import { taskRoutes } from "./server/routes/tasks";
import { vaultRoutes } from "./server/routes/vault";
import { startScheduler } from "./server/sync";

migrate(db, { migrationsFolder: env.MIGRATIONS_DIR });
startScheduler();

// Bun resolves bundled HTML-import chunks relative to cwd, so run from the bundle dir in production.
if (env.NODE_ENV === "production") process.chdir(import.meta.dir);

const server = serve({
  port: env.PORT,
  // Raw messages can be large
  maxRequestBodySize: 512 * 1024 * 1024,
  routes: protect({
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/health": () => Response.json({ status: "ok" }),
    "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),

    ...authRoutes,
    ...vaultRoutes,
    ...accountRoutes,
    ...mailRoutes,
    ...taskRoutes,
  }),

  error: errorResponse,

  development: env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`📬 Mailback running at ${server.url}`);
if (env.MAILBACK_READ_ONLY) console.log("🔒 Read-only mode: Mailback never writes to IMAP servers, restore is disabled.");
