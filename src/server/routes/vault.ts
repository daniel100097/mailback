import { z } from "zod";
import { importPublicKey, type VaultPayload } from "@/shared/crypto";
import { db, schema } from "../db";
import { HttpError, parseBody } from "../http";

const base64 = z.base64();

const vaultSchema = z.object({
  publicKey: base64,
  encryptedPrivateKey: z.object({
    ciphertext: base64,
    iv: base64,
    kdf: z.object({
      name: z.literal("PBKDF2"),
      hash: z.literal("SHA-256"),
      iterations: z.int().min(100_000),
      salt: base64,
    }),
  }),
  wrappedUserKey: base64,
}) satisfies z.ZodType<VaultPayload>;

export const vaultRoutes = {
  "/api/vault": {
    GET() {
      const row = db.select().from(schema.vault).get();
      if (!row) return Response.json({ configured: false });
      const vault: VaultPayload = {
        publicKey: row.publicKey,
        encryptedPrivateKey: row.encryptedPrivateKey,
        wrappedUserKey: row.wrappedUserKey,
      };
      return Response.json({ configured: true, vault });
    },

    async POST(req: Request) {
      const payload = await parseBody(req, vaultSchema);
      await importPublicKey(payload.publicKey).catch(() => {
        throw new HttpError(400, "Invalid public key");
      });
      const inserted = db.insert(schema.vault).values(payload).onConflictDoNothing().returning().get();
      if (!inserted) throw new HttpError(409, "Encryption is already set up");
      return Response.json({ configured: true }, { status: 201 });
    },
  },
};
