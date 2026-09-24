import { and, eq } from "drizzle-orm";
import PostalMime, { type Address as PostalAddress, type Email } from "postal-mime";
import { aad, generateAesKey, importPublicKey, seal, sealJson, wrapAesKey, type MessageLocation } from "@/shared/crypto";
import { formatAddresses, listedAttachments, type Address, type Envelope, type SearchDoc } from "@/shared/mail";
import { db, schema } from "./db";
import { env } from "./env";
import { HttpError } from "./http";
import { createImapClient, describeImapError } from "./imap";
import { decryptSecret } from "./secret";

const MAX_SEARCH_TEXT = 20_000;
const SNIPPET_LENGTH = 200;

const running = new Set<number>();

export function isSyncing(accountId: number): boolean {
  return running.has(accountId);
}

/** Start a sync in the background. Throws if one is already running or encryption isn't set up. */
export function startSync(accountId: number): void {
  if (running.has(accountId)) throw new HttpError(409, "A sync is already running for this account");
  if (!db.select({ id: schema.vault.id }).from(schema.vault).get()) {
    throw new HttpError(409, "Set up encryption before syncing");
  }
  running.add(accountId);
  syncAccount(accountId).finally(() => running.delete(accountId));
}

async function syncAccount(accountId: number): Promise<void> {
  const run = db.insert(schema.syncRuns).values({ accountId }).returning().get();
  let messagesFetched = 0;

  try {
    const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    const vault = db.select().from(schema.vault).get();
    if (!account) throw new Error("Account not found");
    if (!vault) throw new Error("Encryption is not set up");

    const publicKey = await importPublicKey(vault.publicKey);

    const client = createImapClient({ ...account, password: await decryptSecret(account.password) });
    let connectionError: unknown;
    client.on("error", error => (connectionError = error));
    await client.connect();

    try {
      for (const folder of await client.list()) {
        if (folder.flags.has("\\Noselect") || folder.flags.has("\\NonExistent")) continue;

        const mailbox = db
          .insert(schema.mailboxes)
          .values({ accountId, path: folder.path, delimiter: folder.delimiter, specialUse: folder.specialUse })
          .onConflictDoUpdate({
            target: [schema.mailboxes.accountId, schema.mailboxes.path],
            set: { delimiter: folder.delimiter, specialUse: folder.specialUse ?? null },
          })
          .returning()
          .get();

        const lock = await client.getMailboxLock(folder.path, { readOnly: true });
        try {
          if (!client.mailbox) continue;
          const uidValidity = Number(client.mailbox.uidValidity);
          let lastSyncedUid = mailbox.uidValidity === uidValidity ? mailbox.lastSyncedUid : 0;
          if (mailbox.uidValidity !== uidValidity) {
            db.update(schema.mailboxes)
              .set({ uidValidity, lastSyncedUid: 0 })
              .where(eq(schema.mailboxes.id, mailbox.id))
              .run();
          }
          if (client.mailbox.exists === 0 || client.mailbox.uidNext <= lastSyncedUid + 1) continue;

          // A fresh data key per folder and run: handing a task the keys of one folder reveals nothing
          // else. It is wrapped for the vault and otherwise only lives in memory until this loop ends.
          const dataKey = await generateAesKey();
          let dataKeyId: number | undefined;
          const getDataKeyId = async () => {
            dataKeyId ??= db
              .insert(schema.dataKeys)
              .values({ wrappedKey: await wrapAesKey(publicKey, dataKey) })
              .returning()
              .get().id;
            return dataKeyId;
          };

          const fetchQuery = { uid: true, flags: true, internalDate: true, size: true, source: true };
          for await (const msg of client.fetch(`${lastSyncedUid + 1}:*`, fetchQuery, { uid: true })) {
            // `N:*` always returns the last message, even if its UID is below N.
            if (msg.uid <= lastSyncedUid || !msg.source) continue;

            const location = { mailboxId: mailbox.id, uidValidity, uid: msg.uid };
            const sealed = await encryptMessage(dataKey, location, msg.source);
            const keyId = await getDataKeyId();

            db.transaction(tx => {
              const exists = tx
                .select({ id: schema.messages.id })
                .from(schema.messages)
                .where(
                  and(
                    eq(schema.messages.mailboxId, mailbox.id),
                    eq(schema.messages.uidValidity, uidValidity),
                    eq(schema.messages.uid, msg.uid),
                  ),
                )
                .get();
              if (!exists) {
                const row = tx
                  .insert(schema.messages)
                  .values({
                    ...location,
                    dataKeyId: keyId,
                    envelope: sealed.envelope,
                    searchDoc: sealed.searchDoc,
                    receivedAt: msg.internalDate ? new Date(msg.internalDate) : null,
                    flags: [...(msg.flags ?? [])].filter(f => f !== "\\Recent"), // session-only flag
                    size: msg.size ?? msg.source!.length,
                  })
                  .returning({ id: schema.messages.id })
                  .get();
                tx.insert(schema.messageSources).values({ messageId: row.id, source: sealed.source }).run();
              }
              tx.update(schema.mailboxes)
                .set({ lastSyncedUid: msg.uid })
                .where(eq(schema.mailboxes.id, mailbox.id))
                .run();
            });
            lastSyncedUid = msg.uid;

            if (++messagesFetched % 25 === 0) {
              db.update(schema.syncRuns).set({ messagesFetched }).where(eq(schema.syncRuns.id, run.id)).run();
            }
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
    if (connectionError) throw connectionError;

    const now = new Date();
    db.update(schema.syncRuns)
      .set({ status: "success", messagesFetched, finishedAt: now })
      .where(eq(schema.syncRuns.id, run.id))
      .run();
    db.update(schema.accounts).set({ lastSyncAt: now }).where(eq(schema.accounts.id, accountId)).run();
  } catch (error) {
    console.error(`Sync of account ${accountId} failed:`, error);
    db.update(schema.syncRuns)
      .set({ status: "failed", messagesFetched, error: describeImapError(error), finishedAt: new Date() })
      .where(eq(schema.syncRuns.id, run.id))
      .run();
  }
}

async function encryptMessage(key: CryptoKey, location: MessageLocation, source: Buffer) {
  let parsed: Email | undefined;
  try {
    parsed = await PostalMime.parse(source);
  } catch (error) {
    // Still back up the raw source, even if we can't make sense of it.
    console.warn(`Could not parse message ${location.mailboxId}/${location.uid}:`, error);
  }

  const text = (parsed?.text ?? htmlToText(parsed?.html ?? "")).replace(/\s+/g, " ").trim();
  const attachments = parsed?.attachments.map(a => a.filename ?? "").filter(Boolean) ?? [];
  const envelope: Envelope = {
    subject: parsed?.subject ?? "",
    from: flattenAddresses(parsed?.from ? [parsed.from] : []),
    to: flattenAddresses(parsed?.to ?? []),
    cc: flattenAddresses(parsed?.cc ?? []),
    date: parsed?.date ?? null,
    messageId: parsed?.messageId ?? null,
    snippet: text.slice(0, SNIPPET_LENGTH),
    attachments: parsed ? listedAttachments(parsed).length : 0,
  };
  const searchDoc: SearchDoc = {
    subject: envelope.subject,
    from: formatAddresses(envelope.from),
    to: formatAddresses([...envelope.to, ...envelope.cc]),
    text: text.slice(0, MAX_SEARCH_TEXT),
    attachments,
  };

  const [sealedEnvelope, sealedSearchDoc, sealedSource] = await Promise.all([
    sealJson(key, envelope, aad.envelope(location)),
    sealJson(key, searchDoc, aad.searchDoc(location)),
    seal(key, source, aad.source(location)),
  ]);
  return {
    envelope: Buffer.from(sealedEnvelope),
    searchDoc: Buffer.from(sealedSearchDoc),
    source: Buffer.from(sealedSource),
  };
}

function flattenAddresses(list: PostalAddress[]): Address[] {
  return list.flatMap(a =>
    "group" in a && a.group ? a.group.map(m => ({ name: m.name || undefined, address: m.address })) : [
      { name: a.name || undefined, address: "address" in a ? a.address : undefined },
    ],
  );
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Sync all enabled accounts periodically. */
export function startScheduler(): void {
  // Runs that were in progress when the server stopped will never finish.
  db.update(schema.syncRuns)
    .set({ status: "failed", error: "Interrupted by server restart", finishedAt: new Date() })
    .where(eq(schema.syncRuns.status, "running"))
    .run();

  if (env.SYNC_INTERVAL_MINUTES <= 0) return;
  setInterval(
    () => {
      const accounts = db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.enabled, true))
        .all();
      for (const { id } of accounts) {
        try {
          startSync(id);
        } catch {
          // Already running or no vault yet
        }
      }
    },
    env.SYNC_INTERVAL_MINUTES * 60_000,
  );
}
