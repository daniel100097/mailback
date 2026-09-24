/**
 * Crypto primitives shared by the server (Bun) and the browser. WebCrypto only.
 *
 * Key hierarchy:
 * - Vault key pair (RSA-OAEP 4096). Generated in the browser. The public key is given to the
 *   server; the private key is only ever stored encrypted with a passphrase-derived key (PBKDF2).
 * - Data keys (AES-256-GCM). The server generates one per folder and sync run, encrypts mail with it, stores
 *   it wrapped with the vault public key and forgets it. Only the private key can unwrap it.
 * - User key (AES-256-GCM). Generated in the browser for browser-produced data (e.g. the search
 *   index), stored wrapped with the vault public key. The server never sees it unwrapped.
 */

type Bytes = Uint8Array<ArrayBuffer>;

const SEALED_VERSION = 1;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 600_000;

const RSA_ALGORITHM = { name: "RSA-OAEP", hash: "SHA-256" } as const;
const AES_ALGORITHM = { name: "AES-GCM", length: 256 } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- encoding ---------------------------------------------------------------

export function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Bytes {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBytes(data: string | Uint8Array): Bytes {
  if (typeof data === "string") return encoder.encode(data);
  return new Uint8Array(data);
}

// --- authenticated encryption -----------------------------------------------

/** Associated data binds a ciphertext to its purpose and location, so blobs can't be swapped. */
export const aad = {
  envelope: (m: MessageLocation) => `mailback:v1:envelope:${m.mailboxId}/${m.uidValidity}/${m.uid}`,
  searchDoc: (m: MessageLocation) => `mailback:v1:search-doc:${m.mailboxId}/${m.uidValidity}/${m.uid}`,
  source: (m: MessageLocation) => `mailback:v1:source:${m.mailboxId}/${m.uidValidity}/${m.uid}`,
  searchIndex: "mailback:v1:search-index",
  serverSecret: "mailback:v1:server-secret",
};

export type MessageLocation = { mailboxId: number; uidValidity: number; uid: number };

/** AES-256-GCM encrypt. Output: [version (1)][iv (12)][ciphertext + tag]. */
export async function seal(key: CryptoKey, plaintext: string | Uint8Array, associatedData: string): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(associatedData) },
    key,
    toBytes(plaintext),
  );
  const out = new Uint8Array(1 + IV_LENGTH + ciphertext.byteLength);
  out[0] = SEALED_VERSION;
  out.set(iv, 1);
  out.set(new Uint8Array(ciphertext), 1 + IV_LENGTH);
  return out;
}

export async function open(key: CryptoKey, sealed: Uint8Array, associatedData: string): Promise<Bytes> {
  if (sealed[0] !== SEALED_VERSION) throw new Error(`Unsupported ciphertext version: ${sealed[0]}`);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBytes(sealed.subarray(1, 1 + IV_LENGTH)), additionalData: encoder.encode(associatedData) },
    key,
    toBytes(sealed.subarray(1 + IV_LENGTH)),
  );
  return new Uint8Array(plaintext);
}

export async function sealJson(key: CryptoKey, value: unknown, associatedData: string): Promise<Bytes> {
  return seal(key, JSON.stringify(value), associatedData);
}

export async function openJson<T>(key: CryptoKey, sealed: Uint8Array, associatedData: string): Promise<T> {
  return JSON.parse(decoder.decode(await open(key, sealed, associatedData))) as T;
}

// --- symmetric keys ---------------------------------------------------------

export function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES_ALGORITHM, true, ["encrypt", "decrypt"]);
}

export function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toBytes(raw), AES_ALGORITHM, extractable, ["encrypt", "decrypt"]);
}

export async function exportAesKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

// --- vault key pair ---------------------------------------------------------

export function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromBase64(spkiBase64), RSA_ALGORITHM, true, ["wrapKey"]);
}

/** Wrap an AES key with the vault public key. */
export async function wrapAesKey(publicKey: CryptoKey, key: CryptoKey): Promise<string> {
  return toBase64(await crypto.subtle.wrapKey("raw", key, publicKey, RSA_ALGORITHM));
}

/** Unwrap an AES key with the vault private key (browser only). */
export function unwrapAesKey(privateKey: CryptoKey, wrappedBase64: string, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey("raw", fromBase64(wrappedBase64), privateKey, RSA_ALGORITHM, AES_ALGORITHM, extractable, [
    "encrypt",
    "decrypt",
  ]);
}

/** What the server stores about the vault. Nothing here lets the server decrypt anything. */
export type VaultPayload = {
  publicKey: string;
  encryptedPrivateKey: {
    ciphertext: string;
    iv: string;
    kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  };
  wrappedUserKey: string;
};

async function deriveKek(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toBytes(salt), iterations },
    base,
    AES_ALGORITHM,
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** Create a new vault. Returns the payload for the server and a PEM recovery key for the user. */
export async function createVault(passphrase: string): Promise<{ payload: VaultPayload; recoveryKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { ...RSA_ALGORITHM, modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["wrapKey", "unwrapKey"],
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);

  const [spki, encryptedPrivateKey, pkcs8, wrappedUserKey] = await Promise.all([
    crypto.subtle.exportKey("spki", keyPair.publicKey),
    crypto.subtle.wrapKey("pkcs8", keyPair.privateKey, kek, { name: "AES-GCM", iv }),
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    generateAesKey().then(userKey => wrapAesKey(keyPair.publicKey, userKey)),
  ]);

  return {
    payload: {
      publicKey: toBase64(spki),
      encryptedPrivateKey: {
        ciphertext: toBase64(encryptedPrivateKey),
        iv: toBase64(iv),
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
      },
      wrappedUserKey,
    },
    recoveryKey: toPem(pkcs8),
  };
}

export type UnlockedVault = { privateKey: CryptoKey; userKey: CryptoKey };

/** Decrypt the private key with the passphrase. Throws on a wrong passphrase. */
export async function unlockVault(vault: VaultPayload, passphrase: string): Promise<UnlockedVault> {
  const { ciphertext, iv, kdf } = vault.encryptedPrivateKey;
  const kek = await deriveKek(passphrase, fromBase64(kdf.salt), kdf.iterations);
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.unwrapKey(
      "pkcs8",
      fromBase64(ciphertext),
      kek,
      { name: "AES-GCM", iv: fromBase64(iv) },
      RSA_ALGORITHM,
      false,
      ["unwrapKey"],
    );
  } catch {
    throw new Error("Wrong passphrase");
  }
  return { privateKey, userKey: await unwrapAesKey(privateKey, vault.wrappedUserKey) };
}

/** Unlock with the PEM recovery key instead of the passphrase. */
export async function unlockVaultWithRecoveryKey(vault: VaultPayload, pem: string): Promise<UnlockedVault> {
  let privateKey: CryptoKey;
  let userKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey("pkcs8", fromPem(pem), RSA_ALGORITHM, false, ["unwrapKey"]);
    userKey = await unwrapAesKey(privateKey, vault.wrappedUserKey);
  } catch {
    throw new Error("This recovery key does not belong to this vault");
  }
  return { privateKey, userKey };
}

const PEM_LABEL = "MAILBACK PRIVATE KEY";

function toPem(der: ArrayBuffer): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${PEM_LABEL}-----\n${lines.join("\n")}\n-----END ${PEM_LABEL}-----\n`;
}

function fromPem(pem: string): Bytes {
  return fromBase64(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, ""));
}
