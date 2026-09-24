import { Download, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Mailbox } from "@/lib/api";
import { exportFile, exportStream, pickSaveTarget, saveStream, type ExportFormat } from "@/lib/export";
import { plural } from "@/lib/format";
import { useAccounts, useMailboxes } from "@/lib/queries";
import { useKeyring } from "@/lib/vault";

type Scope = "folder" | "account" | "all";

/** Download backed-up mail as .eml files or mbox. Decrypted in the browser; the server only serves ciphertext. */
export function ExportDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const keyring = useKeyring();
  const accounts = useAccounts();
  const mailboxes = useMailboxes();
  const [scope, setScope] = useState<Scope>("folder");
  const [format, setFormat] = useState<ExportFormat>("eml");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!mailbox) return;
    setScope("folder");
    setProgress(null);
  }, [mailbox]);
  useEffect(() => () => abort.current?.abort(), []);

  const account = accounts.data?.find(a => a.id === mailbox?.accountId);
  const selected = (mailboxes.data ?? []).filter(m =>
    scope === "all" ? true : scope === "account" ? m.accountId === mailbox?.accountId : m.id === mailbox?.id,
  );
  const total = selected.reduce((sum, m) => sum + m.messageCount, 0);
  const label =
    scope === "folder" && mailbox
      ? `${account?.name ?? "mail"} - ${mailboxName(mailbox)}`
      : scope === "account"
        ? (account?.name ?? "mail")
        : `mailback-${new Date().toISOString().slice(0, 10)}`;
  const file = exportFile(format, selected, label);

  function close() {
    abort.current?.abort();
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const controller = new AbortController();
    try {
      const target = await pickSaveTarget(file.name);
      abort.current = controller;
      setProgress({ done: 0, total });
      const stream = exportStream({
        keyring,
        format,
        mailboxes: selected,
        accounts: accounts.data ?? [],
        onProgress: done => setProgress({ done, total }),
        signal: controller.signal,
      });
      await saveStream(stream, target, file, controller.signal);
      toast.success(`Exported ${plural(total, "message")}.`);
      onClose();
    } catch (error) {
      // Cancelled in the save picker or by closing the dialog
      if ((error as Error).name === "AbortError" || controller.signal.aborted) return;
      toast.error(`Export failed: ${(error as Error).message}`);
    } finally {
      if (abort.current === controller) abort.current = null;
      setProgress(null);
    }
  }

  const running = progress !== null;
  return (
    <Dialog open={!!mailbox} onOpenChange={open => !open && close()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Export mail</DialogTitle>
            <DialogDescription>Download backed-up messages to import them into a mail client.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>What</Label>
            <Select value={scope} onValueChange={v => setScope(v as Scope)} disabled={running}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="folder">Folder {mailbox?.path}</SelectItem>
                <SelectItem value="account">All folders of {account?.name}</SelectItem>
                {(accounts.data?.length ?? 0) > 1 && <SelectItem value="all">All accounts</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Format</Label>
            <Select value={format} onValueChange={v => setFormat(v as ExportFormat)} disabled={running}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="eml">EML files (ZIP)</SelectItem>
                <SelectItem value="mbox">mbox</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {format === "eml"
                ? `One .eml file per message${selected.length > 1 ? ", in a directory per folder" : ""}.`
                : "One .mbox file per folder, for Thunderbird, Apple Mail, mutt and others."}{" "}
              Saved as <span className="font-medium [overflow-wrap:anywhere]">{file.name}</span>.
            </p>
          </div>
          {running ? (
            <div className="grid gap-2">
              <Progress value={total ? (progress.done / total) * 100 : 100} />
              <p className="text-xs text-muted-foreground tabular-nums">
                {progress.done.toLocaleString()} of {plural(total, "message")}
              </p>
            </div>
          ) : (
            <Alert>
              <ShieldCheck />
              <AlertDescription>
                Your browser decrypts the messages. The exported file is not encrypted, so store it safely.
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={running || total === 0}>
              {running ? <Loader2 className="animate-spin" /> : <Download />} Export {plural(total, "message")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
