import type { BunRequest } from "bun";
import { and, asc, count, desc, eq, gt, inArray, sql, sum } from "drizzle-orm";
import { toBase64 } from "@/shared/crypto";
import { db, schema } from "../db";
import { HttpError, notFound, parseId } from "../http";

const MAX_SEARCH_INDEX_BYTES = 512 * 1024 * 1024;
const EXPORT_BATCH_MESSAGES = 200;
const EXPORT_BATCH_BYTES = 16 * 1024 * 1024;

function wrappedKeys(ids: number[]): Record<number, string> {
  if (ids.length === 0) return {};
  const rows = db
    .select()
    .from(schema.dataKeys)
    .where(inArray(schema.dataKeys.id, [...new Set(ids)]))
    .all();
  return Object.fromEntries(rows.map(r => [r.id, r.wrappedKey]));
}

function intParam(url: URL, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `Invalid ${name}`);
  return Math.min(value, max);
}

const messageColumns = {
  id: schema.messages.id,
  mailboxId: schema.messages.mailboxId,
  uid: schema.messages.uid,
  uidValidity: schema.messages.uidValidity,
  dataKeyId: schema.messages.dataKeyId,
  receivedAt: schema.messages.receivedAt,
  flags: schema.messages.flags,
  size: schema.messages.size,
};

export const mailRoutes = {
  "/api/stats": () => {
    const accounts = db.select({ count: count() }).from(schema.accounts).get()!;
    const mailboxes = db.select({ count: count() }).from(schema.mailboxes).get()!;
    const messages = db.select({ count: count(), bytes: sum(schema.messages.size) }).from(schema.messages).get()!;
    return Response.json({
      accounts: accounts.count,
      mailboxes: mailboxes.count,
      messages: messages.count,
      bytes: Number(messages.bytes ?? 0),
    });
  },

  "/api/mailboxes": () => {
    const rows = db
      .select({
        id: schema.mailboxes.id,
        accountId: schema.mailboxes.accountId,
        path: schema.mailboxes.path,
        delimiter: schema.mailboxes.delimiter,
        specialUse: schema.mailboxes.specialUse,
        messageCount: count(schema.messages.id),
      })
      .from(schema.mailboxes)
      .leftJoin(schema.messages, eq(schema.messages.mailboxId, schema.mailboxes.id))
      .groupBy(schema.mailboxes.id)
      .orderBy(schema.mailboxes.accountId, schema.mailboxes.path)
      .all();
    return Response.json(rows);
  },

  "/api/mailboxes/:id/messages": (req: BunRequest<"/api/mailboxes/:id/messages">) => {
    const mailboxId = parseId(req.params.id);
    const url = new URL(req.url);
    const limit = intParam(url, "limit", 50, 500);
    const offset = intParam(url, "offset", 0);

    const rows = db
      .select({ ...messageColumns, envelope: schema.messages.envelope })
      .from(schema.messages)
      .where(eq(schema.messages.mailboxId, mailboxId))
      .orderBy(desc(schema.messages.receivedAt), desc(schema.messages.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total = db.select({ count: count() }).from(schema.messages).where(eq(schema.messages.mailboxId, mailboxId)).get()!;

    return Response.json({
      total: total.count,
      messages: rows.map(r => ({ ...r, envelope: toBase64(r.envelope) })),
      keys: wrappedKeys(rows.map(r => r.dataKeyId)),
    });
  },

  /** Encrypted envelopes and sources of a folder in id order, in batches of limited size, for exports. */
  "/api/mailboxes/:id/sources": (req: BunRequest<"/api/mailboxes/:id/sources">) => {
    const mailboxId = parseId(req.params.id);
    const after = intParam(new URL(req.url), "after", 0);

    const candidates = db
      .select({ id: schema.messages.id, bytes: sql<number>`length(${schema.messageSources.source})` })
      .from(schema.messages)
      .innerJoin(schema.messageSources, eq(schema.messageSources.messageId, schema.messages.id))
      .where(and(eq(schema.messages.mailboxId, mailboxId), gt(schema.messages.id, after)))
      .orderBy(asc(schema.messages.id))
      .limit(EXPORT_BATCH_MESSAGES)
      .all();
    const ids: number[] = [];
    let bytes = 0;
    for (const candidate of candidates) {
      if (ids.length > 0 && bytes + candidate.bytes > EXPORT_BATCH_BYTES) break;
      ids.push(candidate.id);
      bytes += candidate.bytes;
    }

    const rows = ids.length
      ? db
          .select({ ...messageColumns, envelope: schema.messages.envelope, source: schema.messageSources.source })
          .from(schema.messages)
          .innerJoin(schema.messageSources, eq(schema.messageSources.messageId, schema.messages.id))
          .where(inArray(schema.messages.id, ids))
          .orderBy(asc(schema.messages.id))
          .all()
      : [];
    const more = ids.length < candidates.length || candidates.length === EXPORT_BATCH_MESSAGES;

    return Response.json({
      messages: rows.map(r => ({ ...r, envelope: toBase64(r.envelope), source: toBase64(r.source) })),
      keys: wrappedKeys(rows.map(r => r.dataKeyId)),
      next: more ? ids.at(-1) : null,
    });
  },

  "/api/messages/:id": (req: BunRequest<"/api/messages/:id">) => {
    const message = db
      .select({ ...messageColumns, envelope: schema.messages.envelope })
      .from(schema.messages)
      .where(eq(schema.messages.id, parseId(req.params.id)))
      .get();
    if (!message) throw notFound("Message not found");
    return Response.json({
      ...message,
      envelope: toBase64(message.envelope),
      wrappedKey: wrappedKeys([message.dataKeyId])[message.dataKeyId],
    });
  },

  "/api/messages/:id/source": (req: BunRequest<"/api/messages/:id/source">) => {
    const row = db
      .select({ source: schema.messageSources.source })
      .from(schema.messageSources)
      .where(eq(schema.messageSources.messageId, parseId(req.params.id)))
      .get();
    if (!row) throw notFound("Message not found");
    return new Response(new Uint8Array(row.source), { headers: { "Content-Type": "application/octet-stream" } });
  },

  /** Encrypted search documents, for incrementally building the browser-side index. */
  "/api/search-docs": (req: Request) => {
    const url = new URL(req.url);
    const after = intParam(url, "after", 0);
    const limit = intParam(url, "limit", 200, 1000);

    const rows = db
      .select({ ...messageColumns, searchDoc: schema.messages.searchDoc })
      .from(schema.messages)
      .where(gt(schema.messages.id, after))
      .orderBy(asc(schema.messages.id))
      .limit(limit)
      .all();
    const remaining = db.select({ count: count() }).from(schema.messages).where(gt(schema.messages.id, after)).get()!;

    return Response.json({
      remaining: remaining.count,
      docs: rows.map(r => ({ ...r, searchDoc: toBase64(r.searchDoc) })),
      keys: wrappedKeys(rows.map(r => r.dataKeyId)),
    });
  },

  /** The search index, encrypted by the browser with the user key. Opaque to the server. */
  "/api/search-index": {
    GET() {
      const row = db.select().from(schema.searchIndex).get();
      if (!row) return new Response(null, { status: 204 });
      return new Response(new Uint8Array(row.data), { headers: { "Content-Type": "application/octet-stream" } });
    },

    async PUT(req: Request) {
      const data = Buffer.from(await req.arrayBuffer());
      if (data.length === 0 || data.length > MAX_SEARCH_INDEX_BYTES) throw new HttpError(400, "Invalid index size");
      db.insert(schema.searchIndex)
        .values({ data })
        .onConflictDoUpdate({ target: schema.searchIndex.id, set: { data, updatedAt: new Date() } })
        .run();
      return new Response(null, { status: 204 });
    },
  },
};

