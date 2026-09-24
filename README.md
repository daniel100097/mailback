# Mailback

Self-hosted backup for IMAP email: it keeps an encrypted local copy of your mailboxes that only your browser can read.

- **Runtime / bundler:** [Bun](https://bun.com) (`Bun.serve` + HTML imports, no Vite)
- **UI:** React 19, Tailwind v4, [shadcn/ui](https://ui.shadcn.com), TanStack Query
- **DB:** SQLite (`bun:sqlite`) via [Drizzle ORM](https://orm.drizzle.team). Everything, including raw mail and the search index, lives in this one file.
- **IMAP:** [imapflow](https://github.com/postalsys/imapflow), parsing with [postal-mime](https://github.com/postalsys/postal-mime), search with [MiniSearch](https://github.com/lucaong/minisearch)

## How the encryption works

The server syncs mail on its own schedule, but once a message is stored it can't read it again.

1. On first start, the browser generates an **RSA-OAEP-4096 key pair**. The private key is wrapped with a key
   derived from your passphrase (PBKDF2-SHA256, 600k iterations, AES-GCM). The server stores the public key and the
   wrapped private key.
   - You also get a **recovery key**: the plain private key as a PEM file. Keep it offline.
2. During a sync the server encrypts each message with an **AES-256-GCM data key**. There is a fresh key per folder
   and sync run, and each key is wrapped with the public key. The server then drops the key from memory.
   - Envelope (subject, addresses, snippet), search text and the raw RFC 822 source are sealed separately.
   - Each ciphertext is bound to its message via AES-GCM additional data, so ciphertexts can't be swapped between
     rows.
3. The **browser** unlocks the private key with your passphrase and keeps it in memory only, as a non-extractable
   key. It unwraps data keys, decrypts and parses mail, and renders HTML in a sandboxed iframe that blocks scripts
   and all remote content.
   - The vault locks after 30 minutes of inactivity, on reload, or when you press Lock.
4. **Full-text search** runs in the browser. It builds a MiniSearch index from the decrypted search docs, then
   gzips and encrypts it and stores it on the server. Only new messages are indexed after that.
5. **Tasks that need plaintext** (currently: restoring a folder to an IMAP account) get keys from the browser.
   The browser unwraps only that folder's data keys and sends them with the task. The server holds them in memory
   until the task ends.

IMAP passwords must be readable by the server for scheduled syncs. They are encrypted with a separate server key
(`MAILBACK_SECRET` or `SECRET_KEY_PATH`), which never touches mail.

**Exports** (Export… in a folder's menu) are decrypted in the browser as well. You can export a folder, an
account or everything, as a ZIP of `.eml` files or as mbox (mboxrd, one file per folder). Chromium browsers
stream the file straight to disk; other browsers build it in memory first. The exported file is not encrypted.

**Stored in plaintext:**
- account settings (host, port, username)
- folder paths
- IMAP UIDs, flags, sizes and dates
- sync history

## Login

Set `MAILBACK_PASSWORD_HASH` to require a password for the web UI and API. Without it, the server logs a
warning and anyone who can reach it can use it, so always set it unless Mailback is only reachable by you:

```bash
bun run hash-password                                      # prompts for the password
docker compose run --rm mailback bun scripts/hash-password.ts  # same, in the container
```

Use the printed base64 value: Bun expands `$` in `.env` files even inside quotes, which would mangle the raw
argon2 hash. Sessions are signed cookies (HttpOnly, SameSite=Strict, `Secure` over HTTPS) valid for 30 days.
Changing the password or the server secret signs everyone out. Failed logins are limited to 10 per IP and
15 minutes.

The login is a separate layer from the encryption. It controls who can reach the API; the vault passphrase
controls who can read mail.

**Limitations:**
- The login guards the API, not the data. Anyone who gets hold of the database file (host access, a backup) can
  try to brute-force the wrapped private key offline, so only a long vault passphrase protects the mail there.
- Someone who controls the server can serve modified JavaScript to your browser and capture your passphrase. The
  encryption protects the data at rest (disk, backups, a stolen DB), not against a malicious server.
- If `MAILBACK_SECRET` is not set, the key that protects IMAP passwords sits next to the database.
- Tasks live in memory and are lost on restart.

## Read-only mode

Set `MAILBACK_READ_ONLY=true` to guarantee that Mailback never changes anything on your IMAP servers. Restore
(the only feature that uploads mail) is disabled, and every IMAP client rejects write commands (append, flag
changes, delete, copy, move, folder changes) and opens folders with `EXAMINE` only, so the server doesn't mark
mail as read either. Everything inside Mailback keeps working: syncs, accounts, search and export.

## Development

```bash
bun install
cp .env.example .env   # optional, defaults work
bun dev                # http://localhost:3000, with HMR
```

Migrations are applied automatically on server start.

```bash
bun run typecheck
bun test               # unit tests
bun run test:e2e       # end-to-end against a real IMAP server (GreenMail, needs Docker)
```

## Database

```bash
# after editing src/server/db/schema.ts
bun run db:generate    # create a new migration in ./drizzle
bun run db:migrate     # apply migrations (also runs on startup)
bun run db:studio      # browse the DB
```

## Production

```bash
bun run build          # bundle server + frontend into ./dist
bun start
```

### Docker

Images for `linux/amd64` and `linux/arm64` are published to `ghcr.io/daniel100097/mailback` by GitHub Actions:
`latest` from `main`, `1.2.3` and `1.2` from `v*` tags, and `sha-<commit>` for every build.

```bash
openssl rand -base64 32  # put this into MAILBACK_SECRET (e.g. via .env)
docker compose pull && docker compose up -d   # published image
docker compose up -d --build                   # or build it locally
```

All data (the SQLite database, and the server secret if `MAILBACK_SECRET` isn't set) lives in the `mailback-data`
volume at `/data`.

## Configuration

| Variable                 | Default              | Description                                                            |
| ------------------------ | -------------------- | ---------------------------------------------------------------------- |
| `PORT`                   | `3000`               | HTTP port                                                              |
| `DATABASE_PATH`          | `./data/mailback.db` | SQLite database file                                                   |
| `MIGRATIONS_DIR`         | `./drizzle`          | Drizzle migrations folder                                              |
| `SYNC_INTERVAL_MINUTES`  | `60`                 | Minutes between automatic syncs of enabled accounts, `0` disables them |
| `MAILBACK_SECRET`        |                      | Base64 32-byte key that encrypts IMAP passwords                        |
| `SECRET_KEY_PATH`        | `./data/secret.key`  | Where that key is generated and read if `MAILBACK_SECRET` is unset     |
| `MAILBACK_PASSWORD_HASH` |                      | Login password hash (`bun run hash-password`); unset = no login        |
| `MAILBACK_READ_ONLY`     | `false`              | `true`: never write to IMAP servers (no restore)                       |

## Layout

```
src/
  index.ts                # Bun.serve: API routes + serves the React app
  App.tsx                 # vault gate (setup / unlock) and the app shell
  shared/crypto.ts        # WebCrypto primitives, used by both browser and server
  shared/mail.ts          # encrypted payload shapes (envelope, search doc)
  lib/vault.tsx           # in-memory keyring, unlock/lock, auto-lock
  lib/search.tsx          # in-browser full-text index
  lib/mail.ts             # decrypt + parse messages, safe HTML rendering
  lib/export.ts           # EML/mbox export, decrypted and zipped in the browser
  components/             # pages and dialogs; components/ui = shadcn
  server/
    sync.ts               # IMAP → encrypted SQLite
    tasks.ts              # restore task (uses browser-provided keys)
    secret.ts             # server key for IMAP passwords (and the session signing key)
    auth.ts               # optional login, guards all /api routes
    imap.ts               # IMAP client; MAILBACK_READ_ONLY blocks its write commands
    routes/               # /api/vault, /api/accounts, mail + search, tasks
    db/schema.ts          # drizzle schema
drizzle/                  # generated SQL migrations
scripts/hash-password.ts  # creates MAILBACK_PASSWORD_HASH
test/                     # unit + e2e tests
```
