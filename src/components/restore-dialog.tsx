import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { mailboxName } from "@/components/mailbox-sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type Mailbox, type Task, type WrappedKeys } from "@/lib/api";
import { plural } from "@/lib/format";
import { useAccounts } from "@/lib/queries";
import { useKeyring } from "@/lib/vault";

/**
 * Upload a backed-up folder to an IMAP account. The server needs to read the mail for this, so the
 * browser unwraps exactly the data keys of this folder and hands them over for the task's lifetime.
 */
export function RestoreDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const keyring = useKeyring();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const [targetAccountId, setTargetAccountId] = useState("");
  const [targetPath, setTargetPath] = useState("");

  useEffect(() => {
    if (!mailbox) return;
    setTargetAccountId(String(mailbox.accountId));
    setTargetPath(`${mailboxName(mailbox)} (restored)`);
  }, [mailbox]);

  const restore = useMutation({
    mutationFn: async () => {
      const wrapped = await api<WrappedKeys>(`/api/mailboxes/${mailbox!.id}/data-keys`);
      const keys = await keyring.exportDataKeys(wrapped);
      return api<Task>("/api/tasks/restore", {
        method: "POST",
        json: { mailboxId: mailbox!.id, targetAccountId: Number(targetAccountId), targetPath, keys },
      });
    },
    onSuccess: task => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(`Restoring ${plural(task.total, "message")}. Follow the progress under Accounts.`);
      onClose();
    },
    onError: error => toast.error(error.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    restore.mutate();
  }

  return (
    <Dialog open={!!mailbox} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Restore {mailbox?.path}</DialogTitle>
            <DialogDescription>
              Upload {mailbox?.messageCount === 1 ? "the backed-up message" : `all ${mailbox?.messageCount} backed-up messages`}{" "}
              of this folder to an IMAP account.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>Target account</Label>
            <Select value={targetAccountId} onValueChange={setTargetAccountId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.data?.map(a => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="target-path">Target folder</Label>
            <Input id="target-path" required value={targetPath} onChange={e => setTargetPath(e.target.value)} />
            <p className="text-xs text-muted-foreground">Created if it doesn't exist. Messages are appended.</p>
          </div>
          <Alert>
            <KeyRound />
            <AlertDescription>
              To do this, your browser gives the server the decryption keys for this folder only. The server keeps
              them in memory while the task runs and then forgets them.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!targetAccountId || !targetPath.trim() || restore.isPending}>
              {restore.isPending && <Loader2 className="animate-spin" />} Restore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
