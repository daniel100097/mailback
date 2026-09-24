import { describe, expect, test } from "bun:test";
import {
  aad,
  createVault,
  exportAesKey,
  generateAesKey,
  importAesKey,
  importPublicKey,
  open,
  openJson,
  seal,
  sealJson,
  unlockVault,
  unlockVaultWithRecoveryKey,
  unwrapAesKey,
  wrapAesKey,
} from "@/shared/crypto";

const location = { mailboxId: 1, uidValidity: 42, uid: 7 };

describe("seal/open", () => {
  test("round-trips bytes and JSON", async () => {
    const key = await generateAesKey();
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(await open(key, await seal(key, bytes, "a"), "a")).toEqual(bytes);
    expect(await openJson<unknown>(key, await sealJson(key, { hi: "✉️" }, "b"), "b")).toEqual({ hi: "✉️" });
  });

  test("rejects a ciphertext moved to another message", async () => {
    const key = await generateAesKey();
    const sealed = await seal(key, "secret", aad.source(location));
    await expect(open(key, sealed, aad.source({ ...location, uid: 8 }))).rejects.toThrow();
    await expect(open(key, sealed, aad.envelope(location))).rejects.toThrow();
  });

  test("rejects tampered ciphertext", async () => {
    const key = await generateAesKey();
    const sealed = await seal(key, "secret", "x");
    sealed[sealed.length - 1]! ^= 1;
    await expect(open(key, sealed, "x")).rejects.toThrow();
  });
});

describe("vault", () => {
  // RSA-4096 generation + PBKDF2 are slow; share one vault.
  const created = createVault("correct horse battery staple");

  test("data keys wrapped with the public key unwrap with the passphrase-unlocked private key", async () => {
    const { payload } = await created;
    const dataKey = await generateAesKey();
    const wrapped = await wrapAesKey(await importPublicKey(payload.publicKey), dataKey);

    const { privateKey } = await unlockVault(payload, "correct horse battery staple");
    const unwrapped = await unwrapAesKey(privateKey, wrapped);
    const sealed = await seal(dataKey, "hello", "x");
    expect(new TextDecoder().decode(await open(unwrapped, sealed, "x"))).toBe("hello");
  });

  test("wrong passphrase fails", async () => {
    const { payload } = await created;
    await expect(unlockVault(payload, "wrong")).rejects.toThrow("Wrong passphrase");
  });

  test("recovery key unlocks the same user key", async () => {
    const { payload, recoveryKey } = await created;
    const viaPassphrase = await unlockVault(payload, "correct horse battery staple");
    const viaRecovery = await unlockVaultWithRecoveryKey(payload, recoveryKey);
    const sealed = await seal(viaPassphrase.userKey, "index", aad.searchIndex);
    expect(new TextDecoder().decode(await open(viaRecovery.userKey, sealed, aad.searchIndex))).toBe("index");
  });

  test("a recovery key from another vault is rejected", async () => {
    const { payload } = await created;
    const other = await createVault("x");
    await expect(unlockVaultWithRecoveryKey(payload, other.recoveryKey)).rejects.toThrow("does not belong");
  });

  test("unlocked private key is not extractable", async () => {
    const { privateKey } = await unlockVault((await created).payload, "correct horse battery staple");
    expect(privateKey.extractable).toBe(false);
  });
});

test("exported data keys can be re-imported for tasks", async () => {
  const key = await generateAesKey();
  const sealed = await seal(key, "x", "y");
  const reimported = await importAesKey(await exportAesKey(key));
  expect(new TextDecoder().decode(await open(reimported, sealed, "y"))).toBe("x");
});
