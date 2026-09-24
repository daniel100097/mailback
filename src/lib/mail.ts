import PostalMime, { type Email } from "postal-mime";
import { aad, fromBase64, open, openJson } from "@/shared/crypto";
import type { Envelope } from "@/shared/mail";
import { apiBytes, type EncryptedMessage, type MessageDetail, type WrappedKeys } from "./api";
import type { Keyring } from "./vault";

export type DecryptedMessage = Omit<EncryptedMessage, "envelope"> & { envelope: Envelope };

export async function decryptEnvelope(
  keyring: Keyring,
  message: EncryptedMessage,
  keys: WrappedKeys,
): Promise<DecryptedMessage> {
  const key = await keyring.dataKey(message.dataKeyId, keys[message.dataKeyId]);
  const envelope = await openJson<Envelope>(key, fromBase64(message.envelope), aad.envelope(message));
  return { ...message, envelope };
}

/** Download and decrypt the raw RFC 822 source of a message. */
export async function fetchSource(keyring: Keyring, message: MessageDetail): Promise<Uint8Array<ArrayBuffer>> {
  const sealed = await apiBytes(`/api/messages/${message.id}/source`);
  if (!sealed) throw new Error("Message source is missing");
  const key = await keyring.dataKey(message.dataKeyId, message.wrappedKey);
  return open(key, sealed, aad.source(message));
}

export function parseSource(source: Uint8Array<ArrayBuffer>): Promise<Email> {
  return PostalMime.parse(source);
}

/**
 * Turn an HTML mail body into a document for a sandboxed iframe. The CSP blocks scripts and every
 * network request (no tracking pixels, no remote content); inline cid: images are embedded as data URLs.
 */
export function buildHtmlDocument(email: Email): string {
  let html = email.html ?? "";
  for (const attachment of email.attachments) {
    if (!attachment.contentId) continue;
    const cid = attachment.contentId.replace(/^<|>$/g, "");
    const url = `data:${attachment.mimeType};base64,${bytesToBase64(attachment.content)}`;
    html = html.replaceAll(`cid:${cid}`, url);
  }
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="referrer" content="no-referrer">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`,
    `<base target="_blank">`,
    `<style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111;word-wrap:break-word}img{max-width:100%;height:auto}</style>`,
  ].join("");
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

function bytesToBase64(content: ArrayBuffer | Uint8Array | string): string {
  if (typeof content === "string") return btoa(unescape(encodeURIComponent(content)));
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A filename-safe version of a subject line. */
export function safeFilename(name: string, fallback = "message"): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120);
  return cleaned || fallback;
}
