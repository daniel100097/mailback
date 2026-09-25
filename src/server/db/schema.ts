import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { VaultPayload } from "@/shared/crypto";

const createdAt = integer({ mode: "timestamp" })
  .notNull()
  .default(sql`(unixepoch())`);

const timestamps = {
  createdAt,
  updatedAt: integer({ mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
};

/**
 * The user's key pair (single row). The server only ever holds the public key in usable form;
 * the private key is encrypted with the user's passphrase in the browser.
 */
export const vault = sqliteTable(
  "vault",
  {
    id: integer().primaryKey().default(1),
    publicKey: text().notNull(),
    encryptedPrivateKey: text({ mode: "json" }).$type<VaultPayload["encryptedPrivateKey"]>().notNull(),
    wrappedUserKey: text().notNull(),
    createdAt,
  },
  t => [check("vault_single_row", sql`${t.id} = 1`)],
);

/** An IMAP account to back up. */
export const accounts = sqliteTable("accounts", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  host: text().notNull(),
  port: integer().notNull().default(993),
  secure: integer({ mode: "boolean" }).notNull().default(true),
  username: text().notNull(),
  /** Encrypted with the server secret, so scheduled syncs can log in unattended. */
  password: text().notNull(),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  lastSyncAt: integer({ mode: "timestamp" }),
  ...timestamps,
});

/** A folder on the IMAP server, with the sync cursor for incremental backups. */
export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    path: text().notNull(),
    delimiter: text(),
    specialUse: text(),
    // If UIDVALIDITY changes, previously synced UIDs are no longer valid.
    uidValidity: integer(),
    lastSyncedUid: integer().notNull().default(0),
    /** Set when the folder was no longer listed on the server. Its backup is kept. */
    remoteDeletedAt: integer({ mode: "timestamp" }),
    ...timestamps,
  },
  t => [uniqueIndex("mailboxes_account_path_idx").on(t.accountId, t.path)],
);

/** Per-sync-run AES keys, wrapped with the vault public key. The server cannot unwrap them. */
export const dataKeys = sqliteTable("data_keys", {
  id: integer().primaryKey({ autoIncrement: true }),
  wrappedKey: text().notNull(),
  createdAt,
});

/**
 * A backed-up message. Everything derived from the message content is encrypted with a data key;
 * only IMAP metadata (folder, uid, flags, size, received date) is stored in plaintext.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    mailboxId: integer()
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    uid: integer().notNull(),
    uidValidity: integer().notNull(),
    dataKeyId: integer()
      .notNull()
      .references(() => dataKeys.id),
    /** Encrypted `Envelope` JSON */
    envelope: blob({ mode: "buffer" }).notNull(),
    /** Encrypted `SearchDoc` JSON */
    searchDoc: blob({ mode: "buffer" }).notNull(),
    receivedAt: integer({ mode: "timestamp" }),
    flags: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    size: integer().notNull(),
    /** Set when the message was no longer on the server. Deleted mail is never removed from the backup. */
    remoteDeletedAt: integer({ mode: "timestamp" }),
    createdAt,
  },
  t => [
    uniqueIndex("messages_mailbox_uid_idx").on(t.mailboxId, t.uidValidity, t.uid),
    index("messages_mailbox_received_idx").on(t.mailboxId, t.receivedAt),
  ],
);

/** Encrypted raw RFC 822 source, kept apart so message listings stay small. */
export const messageSources = sqliteTable("message_sources", {
  messageId: integer()
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  source: blob({ mode: "buffer" }).notNull(),
});

/** The browser-built full-text index, encrypted with the user key (single row). */
export const searchIndex = sqliteTable(
  "search_index",
  {
    id: integer().primaryKey().default(1),
    data: blob({ mode: "buffer" }).notNull(),
    updatedAt: integer({ mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  t => [check("search_index_single_row", sql`${t.id} = 1`)],
);

/** History of sync runs per account. */
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    status: text({ enum: ["running", "success", "failed"] })
      .notNull()
      .default("running"),
    messagesFetched: integer().notNull().default(0),
    error: text(),
    startedAt: integer({ mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    finishedAt: integer({ mode: "timestamp" }),
  },
  t => [index("sync_runs_account_started_idx").on(t.accountId, t.startedAt)],
);
