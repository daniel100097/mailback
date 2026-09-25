/**
 * End-to-end: real IMAP server (GreenMail), real server process, browser-side crypto run in Bun.
 * Run with: bun run test:e2e  (needs Docker; see compose.test.yaml)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ImapFlow } from "imapflow";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aad,
  createVault,
  exportAesKey,
  fromBase64,
  open,
  openJson,
  toBase64,
  unlockVault,
  unwrapAesKey,
  type UnlockedVault,
} from "@/shared/crypto";
import type { Envelope, SearchDoc } from "@/shared/mail";

const IMAP_HOST = process.env.IMAP_HOST;
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSPHRASE = "e2e passphrase";
const LOGIN_PASSWORD = "e2e login";

const alice = { username: "alice@example.com", password: "secret" };
const bob = { username: "bob@example.com", password: "secret" };

const MESSAGES = [
  [
    "From: Carol <carol@example.com>",
    "To: alice@example.com",
    "Subject: Quarterly invoice zebra",
    "Date: Tue, 01 Sep 2026 10:00:00 +0000",
    "Message-ID: <one@example.com>",
    "",
    "The payment for project aurora is due.",
  ].join("\r\n"),
  [
    "From: =?UTF-8?Q?J=C3=BCrgen?= <juergen@example.de>",
    "To: alice@example.com",
    "Subject: =?UTF-8?B?R3LDvMOfZSBhdXMgTcO8bmNoZW4g8J+OiQ==?=",
    "Date: Wed, 02 Sep 2026 10:00:00 +0000",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Bratwurst <b>festival</b> tonight</p>",
  ].join("\r\n"),
  [
    "From: dave@example.com",
    "To: alice@example.com",
    "Subject: Report attached",
    "Date: Thu, 03 Sep 2026 10:00:00 +0000",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "See the attachment.",
    "--b1",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQKJcOkw7zDtsOfCg==",
    "--b1--",
  ].join("\r\n"),
];

// Strings that must never appear in the database in plaintext.
const SECRETS = ["zebra", "aurora", "Bratwurst", "report.pdf", "carol@example.com", "Report attached"];

let server: ReturnType<typeof Bun.spawn>;
let dataDir: string;
let vault: UnlockedVault;
let sessionCookie = "";
let passwordHash: string;

async function startServer(env: Record<string, string> = {}) {
  server = Bun.spawn(["bun", "src/index.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      DATABASE_PATH: join(dataDir, "mailback.db"),
      SECRET_KEY_PATH: join(dataDir, "secret.key"),
      SYNC_INTERVAL_MINUTES: "0",
      MAILBACK_PASSWORD_HASH: passwordHash,
      ...env,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, "server", { retryErrors: true });
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: sessionCookie, ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  return (res.status === 204 ? null : res.headers.get("content-type")?.includes("json") ? res.json() : res.arrayBuffer()) as T;
}

function imap(creds: typeof alice) {
  const client = new ImapFlow({
    host: IMAP_HOST!,
    port: IMAP_PORT,
    secure: false,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });
  client.on("error", () => {});
  return client;
}

/** Poll until `check` returns true. Errors are retried only while waiting for services to come up. */
async function waitFor(check: () => Promise<boolean>, what: string, { retryErrors = false, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await (retryErrors ? check().catch(() => false) : check())) return;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe.skipIf(!IMAP_HOST)("e2e", () => {
  beforeAll(async () => {
    // Seed alice's INBOX
    await waitFor(async () => {
      const client = imap(alice);
      await client.connect();
      await client.logout();
      return true;
    }, "IMAP server", { retryErrors: true });
    const client = imap(alice);
    await client.connect();
    for (const message of MESSAGES) await client.append("INBOX", message, ["\\Seen"]);
    await client.logout();

    dataDir = await mkdtemp(join(tmpdir(), "mailback-e2e-"));
    passwordHash = Buffer.from(await Bun.password.hash(LOGIN_PASSWORD)).toString("base64");
    await startServer();
  }, 60_000);

  afterAll(async () => {
    server?.kill();
    await server?.exited;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("the API requires a login", async () => {
    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
    expect((await fetch(`${BASE}/api/vault`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/mailboxes/1/sources`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/vault`, { headers: { Cookie: "mailback_session=v1.9999999999.forged" } })).status).toBe(401);
    expect(await api<object>("/api/session")).toEqual({ required: true, authenticated: false, readOnly: false });

    const login = (password: string) =>
      fetch(`${BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
    expect((await login("wrong")).status).toBe(401);
    const res = await login(LOGIN_PASSWORD);
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    sessionCookie = cookie.split(";")[0]!;
    expect(await api<object>("/api/session")).toEqual({ required: true, authenticated: true, readOnly: false });
  });

  test("syncing requires encryption to be set up", async () => {
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Alice", host: IMAP_HOST, port: IMAP_PORT, secure: false, ...alice }),
    });
    await expect(api("/api/accounts/1/sync", { method: "POST" })).rejects.toThrow("409");
  });

  test("set up the vault", async () => {
    const { payload } = await createVault(PASSPHRASE);
    await api("/api/vault", { method: "POST", body: JSON.stringify(payload) });
    const { vault: stored } = await api("/api/vault");
    vault = await unlockVault(stored, PASSPHRASE);
    // Only one vault
    await expect(api("/api/vault", { method: "POST", body: JSON.stringify(payload) })).rejects.toThrow("409");
  }, 30_000);

  test("rejects accounts with bad credentials", async () => {
    await expect(
      api("/api/accounts", {
        method: "POST",
        body: JSON.stringify({ name: "Bad", host: IMAP_HOST, port: IMAP_PORT, secure: false, ...alice, password: "nope" }),
      }),
    ).rejects.toThrow("Authentication failed");
  });

  test("never returns or stores the IMAP password in plaintext", async () => {
    const accounts = await api("/api/accounts");
    expect(accounts[0]).not.toHaveProperty("password");
    const db = await Bun.file(join(dataDir, "mailback.db")).bytes();
    expect(Buffer.from(db).includes("secret")).toBe(false);
  });

  test("syncs mail", async () => {
    await api("/api/accounts/1/sync", { method: "POST" });
    await waitFor(async () => {
      const [account] = await api("/api/accounts");
      if (account.lastRun?.status === "failed") throw new Error(account.lastRun.error);
      return account.lastRun?.status === "success";
    }, "sync");
    const [account] = await api("/api/accounts");
    expect(account.lastRun.messagesFetched).toBe(3);

    // A second sync is incremental
    await api("/api/accounts/1/sync", { method: "POST" });
    await waitFor(async () => !(await api("/api/accounts"))[0].syncing, "second sync");
    expect((await api("/api/accounts"))[0].lastRun.messagesFetched).toBe(0);
    expect((await api("/api/stats")).messages).toBe(3);
  });

  test("the database contains no plaintext mail", async () => {
    for (const suffix of ["", "-wal"]) {
      const file = Bun.file(join(dataDir, `mailback.db${suffix}`));
      if (!(await file.exists())) continue;
      const bytes = Buffer.from(await file.bytes());
      for (const secret of SECRETS) expect({ secret, found: bytes.includes(secret) }).toEqual({ secret, found: false });
    }
  });

  test("the browser can decrypt envelopes, search docs and sources", async () => {
    const mailboxes = await api("/api/mailboxes");
    const inbox = mailboxes.find((m: any) => m.path === "INBOX");
    expect(inbox.messageCount).toBe(3);

    const { messages, keys } = await api(`/api/mailboxes/${inbox.id}/messages`);
    expect(Object.keys(keys)).toHaveLength(1); // one data key per folder and sync run
    expect(messages.every((m: any) => m.flags.includes("\\Seen") && !m.flags.includes("\\Recent"))).toBe(true);
    const envelopes: Envelope[] = await Promise.all(
      messages.map(async (m: any) =>
        openJson<Envelope>(await unwrapAesKey(vault.privateKey, keys[m.dataKeyId]), fromBase64(m.envelope), aad.envelope(m)),
      ),
    );
    expect(envelopes.map(e => e.subject).sort()).toEqual(
      ["Grüße aus München 🎉", "Quarterly invoice zebra", "Report attached"].sort(),
    );
    const report = envelopes.find(e => e.subject === "Report attached")!;
    expect(report.attachments).toBe(1);
    expect(envelopes.find(e => e.subject.startsWith("Grüße"))!.from[0]).toEqual({ name: "Jürgen", address: "juergen@example.de" });

    const { docs, keys: docKeys, remaining } = await api("/api/search-docs?after=0");
    expect(remaining).toBe(3);
    const searchDocs = await Promise.all(
      docs.map(async (d: any) =>
        openJson<SearchDoc>(await unwrapAesKey(vault.privateKey, docKeys[d.dataKeyId]), fromBase64(d.searchDoc), aad.searchDoc(d)),
      ),
    );
    expect(searchDocs.some(d => d.text.includes("Bratwurst festival"))).toBe(true);
    expect(searchDocs.some(d => d.attachments.includes("report.pdf"))).toBe(true);

    const first = messages.find((m: any) => m.uid === 1);
    const meta = await api(`/api/messages/${first.id}`);
    const sealed = new Uint8Array(await api<ArrayBuffer>(`/api/messages/${first.id}/source`));
    const source = await open(await unwrapAesKey(vault.privateKey, meta.wrappedKey), sealed, aad.source(meta));
    expect(new TextDecoder().decode(source)).toContain("The payment for project aurora is due.");

    // Export batches: every source of the folder, decryptable in the browser
    const batch = await api(`/api/mailboxes/${inbox.id}/sources?after=0`);
    expect(batch.next).toBeNull();
    const sources = await Promise.all(
      batch.messages.map(async (m: any) =>
        new TextDecoder().decode(
          await open(await unwrapAesKey(vault.privateKey, batch.keys[m.dataKeyId]), fromBase64(m.source), aad.source(m)),
        ),
      ),
    );
    expect(sources).toHaveLength(3);
    expect(sources.some(s => s.includes("Subject: Report attached"))).toBe(true);
    const later = await api(`/api/mailboxes/${inbox.id}/sources?after=${batch.messages[0].id}`);
    expect(later.messages).toHaveLength(2);
  });

  test("stores the encrypted search index opaquely", async () => {
    expect(await api("/api/search-index")).toBeNull();
    const blob = new Uint8Array([1, 2, 3]);
    await fetch(`${BASE}/api/search-index`, { method: "PUT", body: blob, headers: { Cookie: sessionCookie } });
    expect(new Uint8Array(await api<ArrayBuffer>("/api/search-index"))).toEqual(blob);
  });

  test("mail deleted on the server is kept and marked as deleted", async () => {
    const sync = async () => {
      await api("/api/accounts/1/sync", { method: "POST" });
      await waitFor(async () => {
        const [account] = await api("/api/accounts");
        if (account.lastRun?.status === "failed") throw new Error(account.lastRun.error);
        return !account.syncing && account.lastRun?.status === "success";
      }, "sync");
    };

    const onServer = async (change: (client: ImapFlow) => Promise<unknown>) => {
      const client = imap(alice);
      await client.connect();
      await change(client);
      await client.logout();
    };

    await onServer(async client => {
      await client.mailboxCreate("Old");
      await client.append("Old", MESSAGES[0]!, []);
    });
    await sync();

    await onServer(async client => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageDelete("1", { uid: true });
      } finally {
        lock.release();
      }
    });
    // Renamed away rather than deleted: GreenMail fails to DELETE a folder that a past session had selected
    await onServer(client => client.mailboxRename("Old", "Renamed"));
    await sync();

    const mailboxes = await api("/api/mailboxes");
    const inbox = mailboxes.find((m: any) => m.path === "INBOX");
    const old = mailboxes.find((m: any) => m.path === "Old");
    expect(inbox).toMatchObject({ messageCount: 3, remoteDeletedAt: null });
    expect(old).toMatchObject({ messageCount: 1, remoteDeletedAt: expect.any(String) });
    // The renamed folder is backed up as a new one
    expect(mailboxes.find((m: any) => m.path === "Renamed")).toMatchObject({ messageCount: 1, remoteDeletedAt: null });
    expect((await api("/api/stats")).messages).toBe(5);

    const { messages } = await api(`/api/mailboxes/${inbox.id}/messages`);
    const deleted = messages.filter((m: any) => m.remoteDeletedAt).map((m: any) => m.uid);
    expect(deleted).toEqual([1]);
    const [oldMessage] = (await api(`/api/mailboxes/${old.id}/messages`)).messages;
    expect(oldMessage.remoteDeletedAt).toEqual(expect.any(String));

    // A folder that reappears is no longer marked
    await onServer(client => client.mailboxRename("Renamed", "Old"));
    await sync();
    const after = await api("/api/mailboxes");
    expect(after.find((m: any) => m.path === "Old").remoteDeletedAt).toBeNull();
    expect(after.find((m: any) => m.path === "Renamed").remoteDeletedAt).toEqual(expect.any(String));
  }, 30_000);

  test("restore task decrypts with browser-provided data keys and uploads to IMAP", async () => {
    const inbox = (await api("/api/mailboxes")).find((m: any) => m.path === "INBOX");
    const wrapped: Record<string, string> = await api(`/api/mailboxes/${inbox.id}/data-keys`);

    // Missing / wrong keys are rejected up front
    const body = { mailboxId: inbox.id, targetAccountId: 2, targetPath: "Restored" };
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Bob", host: IMAP_HOST, port: IMAP_PORT, secure: false, ...bob }),
    });
    await expect(api("/api/tasks/restore", { method: "POST", body: JSON.stringify({ ...body, keys: {} }) })).rejects.toThrow(
      "Missing data key",
    );
    const bogus = Object.fromEntries(Object.keys(wrapped).map(id => [id, toBase64(new Uint8Array(32))]));
    await expect(api("/api/tasks/restore", { method: "POST", body: JSON.stringify({ ...body, keys: bogus }) })).rejects.toThrow(
      "invalid",
    );

    const keys: Record<string, string> = {};
    for (const [id, w] of Object.entries(wrapped)) {
      keys[id] = toBase64(await exportAesKey(await unwrapAesKey(vault.privateKey, w, true)));
    }
    const task = await api("/api/tasks/restore", { method: "POST", body: JSON.stringify({ ...body, keys }) });
    await waitFor(async () => {
      const t = await api(`/api/tasks/${task.id}`);
      if (t.status === "failed") throw new Error(t.error);
      return t.status === "success";
    }, "restore");

    const client = imap(bob);
    await client.connect();
    const lock = await client.getMailboxLock("Restored");
    try {
      const subjects: string[] = [];
      for await (const msg of client.fetch("1:*", { envelope: true, flags: true })) {
        subjects.push(msg.envelope!.subject!);
        expect(msg.flags!.has("\\Seen")).toBe(true);
      }
      expect(subjects.sort()).toEqual(["Grüße aus München 🎉", "Quarterly invoice zebra", "Report attached"].sort());
    } finally {
      lock.release();
      await client.logout();
    }
  }, 30_000);

  test("deleting an account removes its mail and the search index", async () => {
    await api("/api/accounts/1", { method: "DELETE" });
    expect((await api("/api/stats")).messages).toBe(0);
    expect(await api("/api/search-index")).toBeNull();
  });

  test("read-only mode never writes to IMAP but still syncs", async () => {
    const client = imap(bob);
    await client.connect();
    await client.append("INBOX", MESSAGES[0]!, []);
    await client.logout();

    server.kill();
    await server.exited;
    await startServer({ MAILBACK_READ_ONLY: "true" });
    // Same server secret and password hash, so the session survives the restart
    expect(await api<object>("/api/session")).toEqual({ required: true, authenticated: true, readOnly: true });

    const restore = await fetch(`${BASE}/api/tasks/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ mailboxId: 1, targetAccountId: 2, targetPath: "Again", keys: {} }),
    });
    expect(restore.status).toBe(403);
    expect(await restore.text()).toContain("read-only");

    // Changes inside Mailback are still allowed
    await api("/api/accounts/2", { method: "PATCH", body: JSON.stringify({ name: "Bob (read-only)" }) });
    await api("/api/accounts/2/sync", { method: "POST" });
    await waitFor(async () => {
      const [account] = await api("/api/accounts");
      if (account.lastRun?.status === "failed") throw new Error(account.lastRun.error);
      return account.lastRun?.status === "success";
    }, "read-only sync");
    expect((await api("/api/accounts"))[0]).toMatchObject({ name: "Bob (read-only)", lastRun: { messagesFetched: 4 } });

    // Syncing only EXAMINEs folders, so the new message is still unread
    const check = imap(bob);
    await check.connect();
    const lock = await check.getMailboxLock("INBOX", { readOnly: true });
    try {
      const seen = [];
      for await (const msg of check.fetch("1:*", { flags: true })) seen.push(msg.flags!.has("\\Seen"));
      expect(seen).toEqual([false]);
    } finally {
      lock.release();
      await check.logout();
    }
  });
});
