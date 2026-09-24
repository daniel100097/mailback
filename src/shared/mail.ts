/** Shapes of the encrypted per-message payloads. Produced by the server during sync, read by the browser. */
import type { Attachment, Email } from "postal-mime";

export type Address = { name?: string; address?: string };

/** Small, for message lists. */
export type Envelope = {
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  date: string | null;
  messageId: string | null;
  snippet: string;
  attachments: number;
};

/** Plain text used to build the browser-side full-text index. */
export type SearchDoc = {
  subject: string;
  from: string;
  to: string;
  text: string;
  attachments: string[];
};

export function formatAddress(a: Address): string {
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.name ?? a.address ?? "";
}

export function formatAddresses(list: Address[]): string {
  return list.map(formatAddress).join(", ");
}

/** Attachments worth listing: everything except images embedded in the HTML body via cid:. */
export function listedAttachments(email: Email): Attachment[] {
  return email.attachments.filter(a => !(a.related && a.contentId && email.html));
}
