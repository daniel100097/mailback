import type { VaultPayload } from "@/shared/crypto";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when the session is gone (logged out elsewhere or expired), so the app can show the login. */
export const UNAUTHORIZED_EVENT = "mailback:unauthorized";

function checkSession(path: string, res: Response) {
  if (res.status === 401 && path !== "/api/login") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

/** Fetch a JSON API endpoint. Throws an ApiError with the server's message on failure. */
export async function api<T>(path: string, init: Omit<RequestInit, "body"> & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: json === undefined ? rest.headers : { "Content-Type": "application/json", ...rest.headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  if (!res.ok) {
    checkSession(path, res);
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Fetch a binary endpoint. Returns null on 204 No Content. */
export async function apiBytes(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const res = await fetch(path);
  checkSession(path, res);
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  if (res.status === 204) return null;
  return new Uint8Array(await res.arrayBuffer());
}

// --- API shapes (dates arrive as ISO strings) --------------------------------

export type Session = { required: boolean; authenticated: boolean; readOnly: boolean };

export type VaultResponse = { configured: false } | { configured: true; vault: VaultPayload };

export type SyncRun = {
  id: number;
  accountId: number;
  status: "running" | "success" | "failed";
  messagesFetched: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type Account = {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  enabled: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
  syncing: boolean;
  lastRun: SyncRun | null;
};

export type AccountInput = {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  enabled: boolean;
};

export type Mailbox = {
  id: number;
  accountId: number;
  path: string;
  delimiter: string | null;
  specialUse: string | null;
  messageCount: number;
};

export type Stats = { accounts: number; mailboxes: number; messages: number; bytes: number };

type MessageMeta = {
  id: number;
  mailboxId: number;
  uid: number;
  uidValidity: number;
  dataKeyId: number;
  receivedAt: string | null;
  flags: string[];
  size: number;
};

/** Wrapped data keys by id; unwrap them with the vault private key. */
export type WrappedKeys = Record<number, string>;

export type EncryptedMessage = MessageMeta & { envelope: string };

export type MessagePage = { total: number; messages: EncryptedMessage[]; keys: WrappedKeys };

export type MessageDetail = EncryptedMessage & { wrappedKey: string };

export type SourcePage = {
  messages: (EncryptedMessage & { source: string })[];
  keys: WrappedKeys;
  /** Pass as `after` for the next batch; null when done. */
  next: number | null;
};

export type SearchDocPage = { remaining: number; docs: (MessageMeta & { searchDoc: string })[]; keys: WrappedKeys };

export type Task = {
  id: string;
  type: "restore";
  description: string;
  status: "running" | "success" | "failed";
  done: number;
  total: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
