import type { BunRequest } from "bun";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { HttpError, notFound, parseBody, parseId } from "../http";
import { testImapConnection } from "../imap";
import { decryptSecret, encryptSecret } from "../secret";
import { isSyncing, startSync } from "../sync";

const accountFields = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().min(1),
  password: z.string().min(1),
  enabled: z.boolean(),
});
const accountSchema = accountFields.extend({
  port: accountFields.shape.port.default(993),
  secure: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

// When editing, omitted fields (including the password) keep their stored values. No defaults here: zod would
// fill them in and silently reset port, TLS and enabled.
const accountUpdateSchema = accountFields.partial();
const connectionTestSchema = accountSchema
  .pick({ host: true, port: true, secure: true, username: true })
  .extend({ password: z.string().optional(), accountId: z.int().optional() });

function getAccount(id: number) {
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) throw notFound("Account not found");
  return account;
}

function toPublicAccount(account: typeof schema.accounts.$inferSelect) {
  const { password: _, ...rest } = account;
  const lastRun =
    db
      .select()
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.accountId, account.id))
      .orderBy(desc(schema.syncRuns.startedAt), desc(schema.syncRuns.id))
      .get() ?? null;
  return { ...rest, syncing: isSyncing(account.id), lastRun };
}

async function testOrThrow(config: Parameters<typeof testImapConnection>[0]) {
  try {
    await testImapConnection(config);
  } catch (error) {
    throw new HttpError(400, `Could not connect: ${(error as Error).message}`);
  }
}

export const accountRoutes = {
  "/api/accounts": {
    GET() {
      const accounts = db.select().from(schema.accounts).orderBy(schema.accounts.name).all();
      return Response.json(accounts.map(toPublicAccount));
    },

    async POST(req: Request) {
      const input = await parseBody(req, accountSchema);
      await testOrThrow(input);
      const account = db
        .insert(schema.accounts)
        .values({ ...input, password: await encryptSecret(input.password) })
        .returning()
        .get();
      return Response.json(toPublicAccount(account), { status: 201 });
    },
  },

  "/api/accounts/test": {
    async POST(req: Request) {
      const input = await parseBody(req, connectionTestSchema);
      let password = input.password;
      if (!password && input.accountId) password = await decryptSecret(getAccount(input.accountId).password);
      if (!password) throw new HttpError(400, "Password is required");
      await testOrThrow({ ...input, password });
      return Response.json({ ok: true });
    },
  },

  "/api/accounts/:id": {
    async PATCH(req: BunRequest<"/api/accounts/:id">) {
      const existing = getAccount(parseId(req.params.id));
      const input = await parseBody(req, accountUpdateSchema);
      const password = input.password ?? (await decryptSecret(existing.password));
      const merged = { ...existing, ...input, password };
      const connectionChanged = (["host", "port", "secure", "username", "password"] as const).some(
        key => input[key] !== undefined && input[key] !== existing[key],
      );
      if (connectionChanged) await testOrThrow(merged);

      const account = db
        .update(schema.accounts)
        .set({ ...input, password: input.password ? await encryptSecret(input.password) : undefined })
        .where(eq(schema.accounts.id, existing.id))
        .returning()
        .get();
      return Response.json(toPublicAccount(account!));
    },

    DELETE(req: BunRequest<"/api/accounts/:id">) {
      const account = getAccount(parseId(req.params.id));
      if (isSyncing(account.id)) throw new HttpError(409, "Wait for the running sync to finish");
      db.transaction(tx => {
        tx.delete(schema.accounts).where(eq(schema.accounts.id, account.id)).run();
        // The search index contains the deleted messages; the browser rebuilds it.
        tx.delete(schema.searchIndex).run();
      });
      return new Response(null, { status: 204 });
    },
  },

  "/api/accounts/:id/sync": {
    POST(req: BunRequest<"/api/accounts/:id/sync">) {
      const account = getAccount(parseId(req.params.id));
      startSync(account.id);
      return Response.json({ started: true }, { status: 202 });
    },
  },
};
