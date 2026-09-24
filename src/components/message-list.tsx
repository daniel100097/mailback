import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type MessagePage } from "@/lib/api";
import { formatShortDate } from "@/lib/format";
import { decryptEnvelope } from "@/lib/mail";
import type { SearchResult } from "@/lib/search";
import { cn } from "@/lib/utils";
import { useKeyring } from "@/lib/vault";
import { formatAddress } from "@/shared/mail";

const PAGE_SIZE = 50;

function MessageRow({
  selected,
  onClick,
  from,
  date,
  subject,
  snippet,
  attachments,
  unread,
  extra,
}: {
  selected: boolean;
  onClick: () => void;
  from: string;
  date: string | null;
  subject: string;
  snippet?: string;
  attachments?: boolean;
  unread?: boolean;
  extra?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left text-sm hover:bg-accent/60",
        selected && "bg-accent",
      )}
    >
      <div className="flex items-center gap-2">
        {unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
        <span className={cn("truncate", unread ? "font-semibold" : "font-medium")}>{from || "(unknown sender)"}</span>
        {attachments && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatShortDate(date)}</span>
      </div>
      <div className={cn("truncate", unread && "font-semibold")}>{subject || "(no subject)"}</div>
      {snippet && <div className="line-clamp-2 text-xs text-muted-foreground">{snippet}</div>}
      {extra && <div className="truncate text-xs text-muted-foreground">{extra}</div>}
    </button>
  );
}

/** Messages of one mailbox, newest first. Envelopes are decrypted in the browser page by page. */
export function MailboxMessages({
  mailboxId,
  selectedId,
  onSelect,
}: {
  mailboxId: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const keyring = useKeyring();
  const query = useInfiniteQuery({
    queryKey: ["messages", mailboxId],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const page = await api<MessagePage>(`/api/mailboxes/${mailboxId}/messages?limit=${PAGE_SIZE}&offset=${pageParam}`);
      const messages = await Promise.all(page.messages.map(m => decryptEnvelope(keyring, m, page.keys)));
      return { total: page.total, offset: pageParam, messages };
    },
    getNextPageParam: last =>
      last.offset + last.messages.length < last.total ? last.offset + last.messages.length : undefined,
  });

  if (query.isLoading) return <Loader2 className="mx-auto mt-8 animate-spin text-muted-foreground" />;
  if (query.error) return <p className="p-4 text-sm text-destructive">Could not load messages: {query.error.message}</p>;

  const messages = query.data?.pages.flatMap(p => p.messages) ?? [];
  if (messages.length === 0) return <p className="p-4 text-sm text-muted-foreground">No messages in this folder.</p>;

  return (
    <div>
      {messages.map(m => (
        <MessageRow
          key={m.id}
          selected={m.id === selectedId}
          onClick={() => onSelect(m.id)}
          from={m.envelope.from.map(a => a.name || formatAddress(a)).join(", ")}
          date={m.envelope.date ?? m.receivedAt}
          subject={m.envelope.subject}
          snippet={m.envelope.snippet}
          attachments={m.envelope.attachments > 0}
          unread={!m.flags.includes("\\Seen")}
        />
      ))}
      {query.hasNextPage && (
        <div className="p-3 text-center">
          <Button variant="ghost" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
            {query.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more
          </Button>
        </div>
      )}
    </div>
  );
}

export function SearchResults({
  results,
  mailboxNames,
  selectedId,
  onSelect,
}: {
  results: SearchResult[];
  mailboxNames: Map<number, string>;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (results.length === 0) return <p className="p-4 text-sm text-muted-foreground">No matches.</p>;
  return (
    <div>
      {results.map(r => (
        <MessageRow
          key={r.id}
          selected={r.id === selectedId}
          onClick={() => onSelect(r.id)}
          from={r.from}
          date={r.receivedAt}
          subject={r.subject}
          extra={mailboxNames.get(r.mailboxId)}
        />
      ))}
    </div>
  );
}
