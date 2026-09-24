import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AccountDialog } from "@/components/account-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { api, type Account, type Task } from "@/lib/api";
import { formatBytes, formatDate, formatRelative, plural } from "@/lib/format";
import { useAccounts, useStats, useTasks } from "@/lib/queries";
import { useSearch } from "@/lib/search";

export function AccountsPage() {
  const accounts = useAccounts();
  const stats = useStats();
  const tasks = useTasks();
  const [editing, setEditing] = useState<Account | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Account | null>(null);

  const openDialog = (account?: Account) => {
    setEditing(account);
    setDialogOpen(true);
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 overflow-y-auto p-6">
      <section className="grid gap-4 sm:grid-cols-4">
        <Stat label="Accounts" value={stats.data?.accounts} />
        <Stat label="Folders" value={stats.data?.mailboxes} />
        <Stat label="Messages" value={stats.data?.messages.toLocaleString()} />
        <Stat label="Stored" value={stats.data && formatBytes(stats.data.bytes)} />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Accounts</h2>
          <Button onClick={() => openDialog()}>
            <Plus /> Add account
          </Button>
        </div>

        {accounts.isLoading && <Loader2 className="mx-auto animate-spin text-muted-foreground" />}
        {accounts.error && <p className="text-sm text-destructive">{accounts.error.message}</p>}
        {accounts.data?.length === 0 && (
          <Card className="items-center py-12 text-center">
            <Server className="size-10 text-muted-foreground" />
            <CardTitle>No accounts yet</CardTitle>
            <CardDescription>Add an IMAP account to start backing up its mail.</CardDescription>
            <Button onClick={() => openDialog()}>
              <Plus /> Add account
            </Button>
          </Card>
        )}
        {accounts.data?.map(account => (
          <AccountCard
            key={account.id}
            account={account}
            onEdit={() => openDialog(account)}
            onDelete={() => setDeleting(account)}
          />
        ))}
      </section>

      {!!tasks.data?.length && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Tasks</h2>
          {tasks.data.map(task => (
            <TaskRow key={task.id} task={task} />
          ))}
        </section>
      )}

      <AccountDialog account={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
      <DeleteAccountDialog account={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value ?? "–"}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function AccountCard({ account, onEdit, onDelete }: { account: Account; onEdit: () => void; onDelete: () => void }) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api(`/api/accounts/${account.id}/sync`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    onError: error => toast.error(error.message),
  });
  const run = account.lastRun;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {account.name}
          {!account.enabled && <Badge variant="secondary">Scheduled backups off</Badge>}
        </CardTitle>
        <CardDescription>
          {account.username} · {account.host}:{account.port}
          {account.secure ? " (TLS)" : ""}
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={account.syncing || sync.isPending}
            onClick={() => sync.mutate()}
          >
            <RefreshCw className={account.syncing ? "animate-spin" : undefined} />
            {account.syncing ? "Syncing…" : "Sync now"}
          </Button>
          <Button size="icon" variant="ghost" onClick={onEdit} aria-label="Edit">
            <Pencil />
          </Button>
          <Button size="icon" variant="ghost" onClick={onDelete} aria-label="Delete" disabled={account.syncing}>
            <Trash2 />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {!run && <span className="text-muted-foreground">Never synced</span>}
        {run?.status === "running" && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Syncing, {plural(run.messagesFetched, "new message")} so far
          </span>
        )}
        {run?.status === "success" && (
          <span className="flex items-center gap-2 text-muted-foreground" title={formatDate(run.finishedAt)}>
            <CheckCircle2 className="size-4 text-green-600" />
            Last synced {formatRelative(run.finishedAt)}, {plural(run.messagesFetched, "new message")}
          </span>
        )}
        {run?.status === "failed" && (
          <span className="flex items-center gap-2 text-destructive" title={formatDate(run.finishedAt)}>
            <AlertCircle className="size-4" />
            Sync failed {formatRelative(run.finishedAt)}: {run.error}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteAccountDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const search = useSearch();
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      // The index still contains the deleted mail.
      search.rebuild();
      toast.success(`Deleted ${account?.name}`);
      onClose();
    },
    onError: error => toast.error(error.message),
  });

  return (
    <Dialog open={!!account} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {account?.name}?</DialogTitle>
          <DialogDescription>
            This deletes the account and all of its backed-up mail from Mailback. Mail on the IMAP server is not
            touched. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => account && remove.mutate(account.id)}>
            {remove.isPending && <Loader2 className="animate-spin" />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskRow({ task }: { task: Task }) {
  const percent = task.total ? Math.round((task.done / task.total) * 100) : 100;
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium">{task.description}</CardTitle>
        <CardDescription>
          Started {formatRelative(task.startedAt)} · {task.done} / {task.total} messages
        </CardDescription>
        <CardAction>
          <Badge variant={task.status === "failed" ? "destructive" : task.status === "success" ? "default" : "secondary"}>
            {task.status}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        {task.status === "running" && <Progress value={percent} />}
        {task.error && <p className="text-sm text-destructive">{task.error}</p>}
      </CardContent>
    </Card>
  );
}
