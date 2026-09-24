# Mailback

IMAP email backup tool: syncs mailboxes from IMAP servers into an encrypted SQLite copy that only the browser can read.

**Core invariant: the server must never be able to read stored mail.** See README "How the encryption works".
- Sync (`src/server/sync.ts`) seals envelope, search doc and raw source with a fresh AES-GCM data key per folder and run, wraps the key with the user's RSA public key, then forgets it. Never log, cache or persist plaintext or unwrapped keys server-side.
- Decryption, MIME parsing, HTML rendering and full-text search (MiniSearch) happen in the browser (`src/lib/`). The private key lives only in memory (`Keyring` in `src/lib/vault.tsx`).
- Server work that needs plaintext (restore, `src/server/tasks.ts`) receives only the needed data keys from the browser, per task, held in memory.
- IMAP passwords are the exception: encrypted with the server key (`src/server/secret.ts`), since scheduled syncs need them.
- Exports (`src/lib/export.ts`) decrypt in the browser too; `/api/mailboxes/:id/sources` only serves ciphertext.
- The optional login (`MAILBACK_PASSWORD_HASH`, `src/server/auth.ts`) is access control only, not part of the encryption. `protect()` in `src/index.ts` guards every `/api/*` route except those in `PUBLIC_ROUTES`, so new routes are protected automatically.
- `MAILBACK_READ_ONLY` only means "never write to IMAP servers"; UI and DB changes stay allowed. `createImapClient` (`src/server/imap.ts`) rejects every IMAP write command and forces `EXAMINE`, so new IMAP features are covered automatically. Restore returns 403 up front; hide IMAP-writing UI via `useSession().readOnly`.
- Every sealed blob is bound to its row via AAD (`aad.*` in `src/shared/crypto.ts`); keep those in sync when changing schemas.
- Plaintext columns are limited to metadata (folder paths, uid, flags, size, dates, account config). Don't add content-bearing plaintext columns.

Project notes:
- Server: `src/index.ts` (Bun.serve routes under `/api/*` from `src/server/routes/`, serves the React app for everything else)
- DB: SQLite via `bun:sqlite` + Drizzle (`drizzle-orm/bun-sqlite`), schema in `src/server/db/schema.ts`, `casing: "snake_case"`. Raw mail and the encrypted search index are stored in the DB too (no files on disk).
- After schema changes run `bun run db:generate` and commit the generated files in `drizzle/`
- UI: shadcn/ui (`src/components/ui`), TanStack Query for server state (`src/lib/queries.ts`), `api()` helper in `src/lib/api.ts`
- Add shadcn components with `bun x shadcn@3 add <name> -y`, then replace the generated `import { cn } from "cn"` with `@/lib/utils` and `bun remove cn` if it got installed. Adding `alert-dialog` prompts to overwrite `button.tsx`; say no.
- Tests: `bun run typecheck`, `bun test` (unit), `bun run test:e2e` (Docker: GreenMail + real server; asserts no plaintext ends up in the DB)
- `bunfig.toml` sets `install.peer = false`, because otherwise bun-plugin-tailwind pulls in the npm `bun` package, whose shim breaks `bun run` scripts
- Production bundle (`bun run build`) chdirs into `dist/` on start because Bun resolves HTML-import chunks relative to cwd; config paths are resolved to absolute before that in `src/server/env.ts`
- `bun --hot` sometimes fails to resolve newly created files ("Could not resolve"); restart the dev server

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
