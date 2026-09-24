import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Loader2, Mail, Paperclip } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api, type MessageDetail } from "@/lib/api";
import { downloadBlob, formatBytes, formatDate } from "@/lib/format";
import { buildHtmlDocument, decryptEnvelope, fetchSource, parseSource, safeFilename } from "@/lib/mail";
import { useKeyring } from "@/lib/vault";
import { formatAddresses, listedAttachments } from "@/shared/mail";
import type { Attachment } from "postal-mime";

const HIDDEN_FLAGS = new Set(["\\Seen", "\\Recent"]);

function attachmentSize(attachment: Attachment): number {
  const content = attachment.content;
  return typeof content === "string" ? content.length : content.byteLength;
}

/** Downloads, decrypts and parses a message entirely in the browser. */
export function MessageView({ messageId }: { messageId: number }) {
  const keyring = useKeyring();
  const [preferText, setPreferText] = useState(false);

  const query = useQuery({
    queryKey: ["message", messageId],
    queryFn: async () => {
      const detail = await api<MessageDetail>(`/api/messages/${messageId}`);
      const [{ envelope }, source] = await Promise.all([
        decryptEnvelope(keyring, detail, { [detail.dataKeyId]: detail.wrappedKey }),
        fetchSource(keyring, detail),
      ]);
      return { detail, envelope, source, email: await parseSource(source) };
    },
    staleTime: Infinity,
  });

  const htmlDocument = useMemo(() => query.data?.email.html && buildHtmlDocument(query.data.email), [query.data]);

  if (query.isLoading) return <Loader2 className="m-auto animate-spin text-muted-foreground" />;
  if (query.error) {
    return <p className="p-6 text-sm text-destructive">Could not open this message: {query.error.message}</p>;
  }
  const { detail, envelope, source, email } = query.data!;
  const attachments = listedAttachments(email);
  const flags = detail.flags.filter(f => !HIDDEN_FLAGS.has(f));
  const showHtml = htmlDocument && !(preferText && email.text);

  return (
    <article className="flex min-h-0 flex-col">
      <header className="space-y-3 p-6 pb-4">
        <div className="flex items-start gap-4">
          <h2 className="text-lg font-semibold break-words">{envelope.subject || "(no subject)"}</h2>
          <div className="ml-auto flex shrink-0 gap-2">
            {email.html && email.text && (
              <Button variant="outline" size="sm" onClick={() => setPreferText(v => !v)}>
                {preferText ? <Mail /> : <FileText />} {preferText ? "HTML" : "Plain text"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadBlob(source, `${safeFilename(envelope.subject)}.eml`, "message/rfc822")}
            >
              <Download /> .eml
            </Button>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="break-all">{formatAddresses(envelope.from)}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="break-all">{formatAddresses(envelope.to)}</dd>
          {envelope.cc.length > 0 && (
            <>
              <dt className="text-muted-foreground">Cc</dt>
              <dd className="break-all">{formatAddresses(envelope.cc)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatDate(envelope.date ?? detail.receivedAt)}</dd>
        </dl>
        {flags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {flags.map(flag => (
              <Badge key={flag} variant="secondary">
                {flag.replace(/^\\/, "")}
              </Badge>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <Button
                key={i}
                variant="secondary"
                size="sm"
                onClick={() => downloadBlob(a.content as BlobPart, a.filename ?? `attachment-${i + 1}`, a.mimeType)}
              >
                <Paperclip /> {a.filename ?? `attachment-${i + 1}`}
                <span className="text-muted-foreground">{formatBytes(attachmentSize(a))}</span>
              </Button>
            ))}
          </div>
        )}
      </header>
      <Separator />
      {showHtml ? (
        // No scripts, no same-origin access and a CSP that blocks all network requests.
        <iframe
          title="Message body"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={htmlDocument}
          referrerPolicy="no-referrer"
          className="min-h-[60vh] w-full flex-1 bg-white"
        />
      ) : (
        <pre className="p-6 font-sans text-sm whitespace-pre-wrap break-words">{email.text ?? ""}</pre>
      )}
    </article>
  );
}
