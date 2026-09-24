import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { aad, exportAesKey, fromBase64, generateAesKey, importAesKey, open, seal, toBase64 } from "@/shared/crypto";
import { env } from "./env";

/**
 * Server-held key for secrets the server must be able to read on its own (IMAP credentials).
 * Mail content is never encrypted with this key.
 */
async function loadServerSecret(): Promise<Uint8Array<ArrayBuffer>> {
  if (env.MAILBACK_SECRET) return fromBase64(env.MAILBACK_SECRET);

  const file = Bun.file(env.SECRET_KEY_PATH);
  if (await file.exists()) return fromBase64((await file.text()).trim());

  const key = await generateAesKey();
  await mkdir(dirname(env.SECRET_KEY_PATH), { recursive: true });
  await Bun.write(env.SECRET_KEY_PATH, toBase64(await exportAesKey(key)));
  await chmod(env.SECRET_KEY_PATH, 0o600);
  console.warn(
    `⚠️  Generated a new server secret at ${env.SECRET_KEY_PATH}. ` +
      "Set MAILBACK_SECRET to keep it out of the data directory.",
  );
  return exportAesKey(key);
}

const serverSecret = await loadServerSecret();
const serverKey = await importAesKey(serverSecret);

/** A key for signing, derived from the server secret. Different `salt`s give independent keys. */
export async function deriveHmacKey(purpose: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", serverSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(salt), info: new TextEncoder().encode(purpose) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function encryptSecret(plaintext: string): Promise<string> {
  return toBase64(await seal(serverKey, plaintext, aad.serverSecret));
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  return new TextDecoder().decode(await open(serverKey, fromBase64(ciphertext), aad.serverSecret));
}
