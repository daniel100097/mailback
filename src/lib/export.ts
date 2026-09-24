import { makeZip } from "client-zip";
import { aad, fromBase64, open, openJson } from "@/shared/crypto";
import type { Envelope } from "@/shared/mail";
import { api, type Account, type Mailbox, type SourcePage } from "./api";
import { downloadBlob } from "./format";
import { safeFilename } from "./mail";
import type { Keyring } from "./vault";

/**
 * Exports run entirely in the browser: sources are fetched encrypted, decrypted here and streamed
 * into a ZIP (.eml files, or one .mbox per folder) or a single .mbox file.
 */
export type ExportFormat = "eml" | "mbox";

export type ExportMessage = { mailbox: Mailbox; receivedAt: Date | null; envelope: Envelope; source: Uint8Array };

/** Decrypted messages of a folder, fetched in batches. */
export async function* folderMessages(
  keyring: Keyring,
  mailbox: Mailbox,
  signal: AbortSignal,
): AsyncGenerator<ExportMessage> {
  let after: number | null = 0;
  while (after !== null) {
    const page: SourcePage = await api<SourcePage>(`/api/mailboxes/${mailbox.id}/sources?after=${after}`, { signal });
    for (const m of page.messages) {
      const key = await keyring.dataKey(m.dataKeyId, page.keys[m.dataKeyId]);
      const [envelope, source] = await Promise.all([
        openJson<Envelope>(key, fromBase64(m.envelope), aad.envelope(m)),
        open(key, fromBase64(m.source), aad.source(m)),
      ]);
      signal.throwIfAborted();
      yield { mailbox, receivedAt: m.receivedAt ? new Date(m.receivedAt) : null, envelope, source };
    }
    after = page.next;
  }
}

type ExportOptions = {
  keyring: Keyring;
  format: ExportFormat;
  mailboxes: Mailbox[];
  accounts: Account[];
  onProgress: (done: number) => void;
  signal: AbortSignal;
};

/** The exported file: a ZIP, unless it's a single folder as mbox. */
export function exportFile(format: ExportFormat, mailboxes: Mailbox[], label: string) {
  const name = safeFilename(label, "mailback");
  if (format === "mbox" && mailboxes.length === 1) return { name: `${name}.mbox`, type: "application/mbox" };
  return { name: `${name}.zip`, type: "application/zip" };
}

export function exportStream({ keyring, format, mailboxes, accounts, onProgress, signal }: ExportOptions) {
  let done = 0;
  const messages = (mailbox: Mailbox) =>
    tap(folderMessages(keyring, mailbox, signal), () => onProgress(++done));

  if (format === "mbox" && mailboxes.length === 1) return iterableStream(mboxStream(messages(mailboxes[0]!)));

  // Folders become directories: flat for a single folder, per account when exporting several accounts.
  const accountNames = new Map(accounts.map(a => [a.id, a.name]));
  const multipleAccounts = new Set(mailboxes.map(m => m.accountId)).size > 1;
  const dir = (mailbox: Mailbox) => {
    const segments = mailbox.delimiter ? mailbox.path.split(mailbox.delimiter) : [mailbox.path];
    if (multipleAccounts) segments.unshift(accountNames.get(mailbox.accountId) ?? `account-${mailbox.accountId}`);
    return segments.map(s => safeFilename(s, "folder")).join("/");
  };

  async function* entries() {
    for (const mailbox of mailboxes) {
      if (format === "mbox") {
        yield { name: `${dir(mailbox)}.mbox`, input: mboxStream(messages(mailbox)) };
        continue;
      }
      const prefix = mailboxes.length === 1 ? "" : `${dir(mailbox)}/`;
      const names = new UniqueNames();
      for await (const m of messages(mailbox)) {
        const date = sentAt(m);
        const day = date ? `${date.toISOString().slice(0, 10)} ` : "";
        const name = names.take(`${day}${safeFilename(m.envelope.subject, "(no subject)")}`);
        yield { name: `${prefix}${name}.eml`, input: m.source, lastModified: date ?? undefined };
      }
    }
  }
  return makeZip(entries());
}

/**
 * Ask where to save, with the File System Access API (Chromium), so the export streams straight to disk.
 * Must be called before any await in the click handler. Null when unsupported: then it's buffered into a blob.
 */
export async function pickSaveTarget(name: string): Promise<FileSystemFileHandle | null> {
  const w = window as { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle> };
  return w.showSaveFilePicker ? w.showSaveFilePicker({ suggestedName: name }) : null;
}

export async function saveStream(
  stream: ReadableStream<Uint8Array>,
  target: FileSystemFileHandle | null,
  file: { name: string; type: string },
  signal: AbortSignal,
) {
  if (target) return stream.pipeTo(await target.createWritable(), { signal });
  const blob = await new Response(stream, { headers: { "Content-Type": file.type } }).blob();
  signal.throwIfAborted();
  downloadBlob(blob, file.name, file.type);
}

// --- mbox (mboxrd) ------------------------------------------------------------

const encoder = new TextEncoder();
const FROM = encoder.encode("From ");
const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;

async function* mboxStream(messages: AsyncIterable<ExportMessage>): AsyncGenerator<Uint8Array> {
  // The separator carries the delivery date, i.e. the IMAP internal date
  for await (const m of messages) yield mboxEntry(m.source, m.receivedAt ?? sentAt(m));
}

/** `From ` separator line, as in `From MAILER-DAEMON Thu Jan  1 00:00:00 1970`. */
export function mboxFromLine(date: Date | null): string {
  const d = date ?? new Date(0);
  const [weekday, month] = [
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()],
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()],
  ];
  const time = d.toISOString().slice(11, 19);
  return `From MAILER-DAEMON ${weekday} ${month} ${String(d.getUTCDate()).padStart(2, " ")} ${time} ${d.getUTCFullYear()}\n`;
}

/**
 * One mboxrd message: the separator line, the source with LF line endings and `>*From ` lines quoted
 * with one more `>`, and a trailing blank line.
 */
export function mboxEntry(source: Uint8Array, date: Date | null): Uint8Array {
  const header = encoder.encode(mboxFromLine(date));
  let lines = 1;
  for (const byte of source) if (byte === LF) lines++;
  // Worst case: every line gets a ">", plus a final line break and the blank line
  const out = new Uint8Array(header.length + source.length + lines + 2);
  out.set(header);
  let o = header.length;
  let lineStart = true;
  for (let i = 0; i < source.length; i++) {
    const byte = source[i]!;
    if (lineStart && isQuotedFrom(source, i)) out[o++] = GT;
    lineStart = byte === LF;
    if (byte === CR && source[i + 1] === LF) continue;
    out[o++] = byte;
  }
  if (o > header.length && out[o - 1] !== LF) out[o++] = LF;
  out[o++] = LF;
  return out.subarray(0, o);
}

function isQuotedFrom(source: Uint8Array, start: number): boolean {
  let i = start;
  while (source[i] === GT) i++;
  return FROM.every((byte, j) => source[i + j] === byte);
}

// --- helpers ------------------------------------------------------------------

/** The Date header, falling back to when the server received the message. */
function sentAt(m: ExportMessage): Date | null {
  const date = m.envelope.date ? new Date(m.envelope.date) : null;
  return date && !Number.isNaN(date.getTime()) ? date : m.receivedAt;
}

/** File names unique within a folder: "Subject", "Subject (2)", … */
export class UniqueNames {
  private used = new Set<string>();

  take(base: string): string {
    let name = base;
    for (let n = 2; this.used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    this.used.add(name.toLowerCase());
    return name;
  }
}

async function* tap<T>(iterable: AsyncIterable<T>, fn: () => void): AsyncGenerator<T> {
  for await (const item of iterable) {
    yield item;
    fn();
  }
}

function iterableStream(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: reason => void iterator.return?.(reason),
  });
}
