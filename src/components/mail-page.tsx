import { AlertCircle, Loader2, MailOpen, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ExportDialog } from "@/components/export-dialog";
import { MailboxSidebar } from "@/components/mailbox-sidebar";
import { MailboxMessages, SearchResults } from "@/components/message-list";
import { MessageView } from "@/components/message-view";
import { RestoreDialog } from "@/components/restore-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Mailbox } from "@/lib/api";
import { plural } from "@/lib/format";
import { useAccounts, useMailboxes } from "@/lib/queries";
import { useSearch, type SearchStatus } from "@/lib/search";
import { useSession } from "@/lib/session";

export function MailPage({ onManageAccounts }: { onManageAccounts: () => void }) {
  const accounts = useAccounts();
  const mailboxes = useMailboxes();
  const search = useSearch();
  const { readOnly } = useSession();
  const [mailboxId, setMailboxId] = useState<number | null>(null);
  const [messageId, setMessageId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [restoring, setRestoring] = useState<Mailbox | null>(null);
  const [exporting, setExporting] = useState<Mailbox | null>(null);

  // Open the first inbox by default, and move away from folders that no longer exist.
  useEffect(() => {
    const list = mailboxes.data;
    if (!list?.length) return;
    if (mailboxId !== null && list.some(m => m.id === mailboxId)) return;
    setMailboxId((list.find(m => m.path.toUpperCase() === "INBOX") ?? list[0]!).id);
  }, [mailboxes.data, mailboxId]);

  const mailboxNames = useMemo(() => {
    const accountNames = new Map(accounts.data?.map(a => [a.id, a.name]));
    return new Map(mailboxes.data?.map(m => [m.id, `${accountNames.get(m.accountId) ?? "?"} · ${m.path}`]));
  }, [accounts.data, mailboxes.data]);

  const { search: runSearch, version } = search;
  const results = useMemo(() => runSearch(deferredQuery), [runSearch, deferredQuery, version]);
  const searching = deferredQuery.trim().length > 0;

  if (accounts.data?.length === 0) {
    return (
      <div className="m-auto flex flex-col items-center gap-3 text-center">
        <MailOpen className="size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Nothing backed up yet</h2>
        {readOnly ? (
          <p className="text-sm text-muted-foreground">Mailback runs in read-only mode, so accounts can't be added here.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Add an IMAP account to start your first backup.</p>
            <Button onClick={onManageAccounts}>Go to accounts</Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[15rem_24rem_1fr]">
      <MailboxSidebar
        selectedId={searching ? null : mailboxId}
        onSelect={m => {
          setMailboxId(m.id);
          setMessageId(null);
          setQuery("");
        }}
        onRestore={readOnly ? undefined : setRestoring}
        onExport={setExporting}
      />

      <section className="flex min-h-0 flex-col border-r">
        <div className="space-y-1 border-b p-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search all mail"
              className="px-8"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <SearchStatusLine status={search.status} results={searching ? results.length : null} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {searching ? (
            <SearchResults
              results={results}
              mailboxNames={mailboxNames}
              selectedId={messageId}
              onSelect={setMessageId}
            />
          ) : mailboxId !== null ? (
            <MailboxMessages mailboxId={mailboxId} selectedId={messageId} onSelect={setMessageId} />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Run a sync to see your mail here.</p>
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-col overflow-y-auto">
        {messageId !== null ? (
          <MessageView key={messageId} messageId={messageId} />
        ) : (
          <div className="m-auto text-sm text-muted-foreground">Select a message to read it</div>
        )}
      </section>

      <RestoreDialog mailbox={restoring} onClose={() => setRestoring(null)} />
      <ExportDialog mailbox={exporting} onClose={() => setExporting(null)} />
    </div>
  );
}

function SearchStatusLine({ status, results }: { status: SearchStatus; results: number | null }) {
  const className = "flex items-center gap-1.5 px-1 text-xs text-muted-foreground";
  if (status.state === "error") {
    return (
      <p className={`${className} text-destructive`}>
        <AlertCircle className="size-3" /> Search index: {status.error}
      </p>
    );
  }
  if (status.state === "loading") {
    return (
      <p className={className}>
        <Loader2 className="size-3 animate-spin" /> Loading search index…
      </p>
    );
  }
  if (status.state === "indexing") {
    return (
      <p className={className}>
        <Loader2 className="size-3 animate-spin" /> Indexing, {plural(status.remaining, "message")} left. Results
        may be incomplete.
      </p>
    );
  }
  return (
    <p className={className}>
      {results === null
        ? `${plural(status.indexed, "message")} searchable, indexed in this browser`
        : results === 200 ? "200+ matches" : plural(results, "match", "matches")}
    </p>
  );
}
