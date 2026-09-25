import { Archive, CloudOff, Download, File, Folder, Inbox, MoreHorizontal, Send, ShieldAlert, Star, Trash2, Undo2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Mailbox } from "@/lib/api";
import { useAccounts, useMailboxes } from "@/lib/queries";
import { cn } from "@/lib/utils";

const specialUseIcons: Record<string, typeof Folder> = {
  "\\Inbox": Inbox,
  "\\Sent": Send,
  "\\Drafts": File,
  "\\Trash": Trash2,
  "\\Junk": ShieldAlert,
  "\\Archive": Archive,
  "\\Flagged": Star,
};

export function mailboxName(mailbox: Mailbox): string {
  return (mailbox.delimiter ? mailbox.path.split(mailbox.delimiter).at(-1) : mailbox.path) || mailbox.path;
}

function mailboxIcon(mailbox: Mailbox) {
  if (mailbox.path.toUpperCase() === "INBOX") return Inbox;
  return (mailbox.specialUse && specialUseIcons[mailbox.specialUse]) || Folder;
}

function sortKey(mailbox: Mailbox): string {
  // INBOX first, then the folder tree in path order
  return mailbox.path.toUpperCase() === "INBOX" ? "" : mailbox.path.toLowerCase();
}

export function MailboxSidebar({
  selectedId,
  onSelect,
  onRestore,
  onExport,
}: {
  selectedId: number | null;
  onSelect: (mailbox: Mailbox) => void;
  /** Omitted in read-only mode */
  onRestore?: (mailbox: Mailbox) => void;
  onExport: (mailbox: Mailbox) => void;
}) {
  const accounts = useAccounts();
  const mailboxes = useMailboxes();

  const byAccount = useMemo(() => {
    const groups = new Map<number, Mailbox[]>();
    for (const mailbox of mailboxes.data ?? []) {
      groups.set(mailbox.accountId, [...(groups.get(mailbox.accountId) ?? []), mailbox]);
    }
    for (const list of groups.values()) list.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return groups;
  }, [mailboxes.data]);

  return (
    <nav className="flex flex-col gap-4 overflow-y-auto border-r p-2">
      {accounts.data?.map(account => (
        <div key={account.id}>
          <div className="truncate px-2 pb-1 text-xs font-semibold text-muted-foreground uppercase">{account.name}</div>
          {!byAccount.get(account.id)?.length && (
            <p className="px-2 text-xs text-muted-foreground">Not synced yet</p>
          )}
          {byAccount.get(account.id)?.map(mailbox => {
            const Icon = mailboxIcon(mailbox);
            const depth = mailbox.delimiter ? mailbox.path.split(mailbox.delimiter).length - 1 : 0;
            return (
              <div
                key={mailbox.id}
                className={cn(
                  "group flex items-center rounded-md text-sm hover:bg-accent",
                  selectedId === mailbox.id && "bg-accent font-medium",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
                  style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
                  onClick={() => onSelect(mailbox)}
                  title={mailbox.remoteDeletedAt ? `${mailbox.path} (deleted on server, kept in the backup)` : mailbox.path}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className={cn("truncate", mailbox.remoteDeletedAt && "text-muted-foreground")}>
                    {mailboxName(mailbox)}
                  </span>
                  {mailbox.remoteDeletedAt && (
                    <CloudOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Deleted on server" />
                  )}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {mailbox.messageCount || ""}
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                      aria-label={`Actions for ${mailbox.path}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => onExport(mailbox)}>
                      <Download /> Export…
                    </DropdownMenuItem>
                    {onRestore && (
                      <DropdownMenuItem disabled={!mailbox.messageCount} onSelect={() => onRestore(mailbox)}>
                        <Undo2 /> Restore to IMAP…
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
