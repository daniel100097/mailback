import { and, asc, eq } from "drizzle-orm";
import { aad, fromBase64, importAesKey, open } from "@/shared/crypto";
import { db, schema } from "./db";
import { HttpError } from "./http";
import { createImapClient, describeImapError } from "./imap";
import { decryptSecret } from "./secret";

/**
 * Tasks are jobs that need to read mail on the server. The browser unwraps exactly the data keys
 * a task needs and hands them over; they only live in this process's memory while the task runs.
 * The vault private key never leaves the browser.
 */
export type Task = {
  id: string;
  type: "restore";
  description: string;
  status: "running" | "success" | "failed";
  done: number;
  total: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

const tasks = new Map<string, Task>();

export function listTasks(): Task[] {
  return [...tasks.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

/** Data keys (wrapped) needed to read every message in a mailbox. */
export function dataKeysForMailbox(mailboxId: number): Record<number, string> {
  const rows = db
    .selectDistinct({ id: schema.dataKeys.id, wrappedKey: schema.dataKeys.wrappedKey })
    .from(schema.messages)
    .innerJoin(schema.dataKeys, eq(schema.dataKeys.id, schema.messages.dataKeyId))
    .where(eq(schema.messages.mailboxId, mailboxId))
    .all();
  return Object.fromEntries(rows.map(r => [r.id, r.wrappedKey]));
}

type RestoreInput = {
  mailboxId: number;
  targetAccountId: number;
  targetPath: string;
  /** Unwrapped data keys, base64 raw AES keys by data key id */
  keys: Record<string, string>;
};

/** Upload every message of a backed-up mailbox to a folder on an IMAP account. */
export async function startRestore(input: RestoreInput): Promise<Task> {
  const mailbox = db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, input.mailboxId)).get();
  if (!mailbox) throw new HttpError(404, "Mailbox not found");
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, input.targetAccountId)).get();
  if (!account) throw new HttpError(404, "Target account not found");

  const keys = new Map<number, CryptoKey>();
  for (const id of Object.keys(dataKeysForMailbox(mailbox.id)).map(Number)) {
    const raw = input.keys[id];
    if (!raw) throw new HttpError(400, `Missing data key ${id}`);
    const key = await importAesKey(fromBase64(raw));
    // Fail fast on a wrong key rather than halfway through the task.
    const sample = db
      .select({ envelope: schema.messages.envelope, uid: schema.messages.uid, uidValidity: schema.messages.uidValidity })
      .from(schema.messages)
      .where(and(eq(schema.messages.mailboxId, mailbox.id), eq(schema.messages.dataKeyId, id)))
      .get()!;
    await open(key, sample.envelope, aad.envelope({ mailboxId: mailbox.id, ...sample })).catch(() => {
      throw new HttpError(400, `Data key ${id} is invalid`);
    });
    keys.set(id, key);
  }

  const messages = db
    .select({
      id: schema.messages.id,
      uid: schema.messages.uid,
      uidValidity: schema.messages.uidValidity,
      dataKeyId: schema.messages.dataKeyId,
      flags: schema.messages.flags,
      receivedAt: schema.messages.receivedAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.mailboxId, mailbox.id))
    .orderBy(asc(schema.messages.id))
    .all();

  const client = createImapClient({ ...account, password: await decryptSecret(account.password) });
  client.on("error", () => {});

  const task: Task = {
    id: crypto.randomUUID(),
    type: "restore",
    description: `Restore ${mailbox.path} → ${account.name}: ${input.targetPath}`,
    status: "running",
    done: 0,
    total: messages.length,
    error: null,
    startedAt: new Date(),
    finishedAt: null,
  };
  tasks.set(task.id, task);

  (async () => {
    try {
      await client.connect();
      await client.mailboxCreate(input.targetPath);
      for (const message of messages) {
        const row = db
          .select({ source: schema.messageSources.source })
          .from(schema.messageSources)
          .where(eq(schema.messageSources.messageId, message.id))
          .get();
        if (!row) throw new Error(`Source of message ${message.id} is missing`);
        const source = await open(
          keys.get(message.dataKeyId)!,
          row.source,
          aad.source({ mailboxId: mailbox.id, uidValidity: message.uidValidity, uid: message.uid }),
        );
        const flags = message.flags.filter(f => f !== "\\Recent");
        await client.append(input.targetPath, Buffer.from(source), flags, message.receivedAt ?? undefined);
        task.done++;
      }
      task.status = "success";
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof DOMException ? "A data key is invalid" : describeImapError(error);
    } finally {
      task.finishedAt = new Date();
      keys.clear();
      await client.logout().catch(() => client.close());
    }
  })();

  return task;
}
