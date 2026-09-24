import { resolve } from "node:path";

// Paths are resolved against the launch cwd, since the production server chdirs into its bundle dir.
export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 3000),
  DATABASE_PATH: resolve(process.env.DATABASE_PATH ?? "./data/mailback.db"),
  MIGRATIONS_DIR: resolve(process.env.MIGRATIONS_DIR ?? "./drizzle"),
  /** Base64 32-byte key used to encrypt IMAP credentials. Falls back to SECRET_KEY_PATH. */
  MAILBACK_SECRET: process.env.MAILBACK_SECRET,
  SECRET_KEY_PATH: resolve(process.env.SECRET_KEY_PATH ?? "./data/secret.key"),
  /** Login password hash (`bun run hash-password`), as is or base64. Unset = no login. */
  MAILBACK_PASSWORD_HASH: process.env.MAILBACK_PASSWORD_HASH,
  /** Browse, search and export only: no restore, account changes or other writes. Syncs keep running. */
  MAILBACK_READ_ONLY: /^(1|true|yes)$/i.test(process.env.MAILBACK_READ_ONLY ?? ""),
  /** Minutes between automatic syncs of all accounts. 0 disables. */
  SYNC_INTERVAL_MINUTES: Number(process.env.SYNC_INTERVAL_MINUTES ?? 60),
};
