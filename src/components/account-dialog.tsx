import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, PlugZap } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
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
import { Switch } from "@/components/ui/switch";
import { api, type Account, type AccountInput } from "@/lib/api";

const emptyForm: AccountInput = { name: "", host: "", port: 993, secure: true, username: "", password: "", enabled: true };

/** Add or edit an IMAP account. The password is sent once and stored encrypted by the server. */
export function AccountDialog({
  account,
  open,
  onOpenChange,
}: {
  /** Account to edit; omit to add a new one */
  account?: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AccountInput>(emptyForm);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (account) {
      const { name, host, port, secure, username, enabled } = account;
      setForm({ name, host, port, secure, username, enabled, password: "" });
    } else {
      setForm(emptyForm);
    }
    setTested(false);
  }, [open, account]);

  const set = <K extends keyof AccountInput>(key: K, value: AccountInput[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    if (key !== "name" && key !== "enabled") setTested(false);
  };

  // An empty password when editing keeps the stored one.
  const payload = { ...form, password: form.password || undefined };

  const test = useMutation({
    mutationFn: () => api("/api/accounts/test", { method: "POST", json: { ...payload, accountId: account?.id } }),
    onSuccess: () => setTested(true),
    onError: error => toast.error(error.message),
  });

  const save = useMutation({
    mutationFn: () =>
      account
        ? api<Account>(`/api/accounts/${account.id}`, { method: "PATCH", json: payload })
        : api<Account>("/api/accounts", { method: "POST", json: payload }),
    onSuccess: saved => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      toast.success(account ? `Saved ${saved.name}` : `Added ${saved.name}. Start a sync to back it up.`);
      onOpenChange(false);
    },
    onError: error => toast.error(error.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  const canConnect = form.host && form.username && (account || form.password);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{account ? `Edit ${account.name}` : "Add IMAP account"}</DialogTitle>
            <DialogDescription>
              The connection is tested before saving. The password is stored encrypted, so scheduled backups can run
              without you.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Work mail"
                required
                value={form.name}
                onChange={e => set("name", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <div className="grid gap-2">
                <Label htmlFor="host">IMAP server</Label>
                <Input
                  id="host"
                  placeholder="imap.example.com"
                  required
                  value={form.host}
                  onChange={e => set("host", e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={form.port}
                  onChange={e => set("port", Number(e.target.value))}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="secure">TLS</Label>
                <p className="text-xs text-muted-foreground">Connect with implicit TLS (usually port 993).</p>
              </div>
              <Switch
                id="secure"
                checked={form.secure}
                onCheckedChange={secure => {
                  set("secure", secure);
                  if (form.port === 993 || form.port === 143) set("port", secure ? 993 : 143);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="off"
                required
                value={form.username}
                onChange={e => set("username", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required={!account}
                placeholder={account ? "Unchanged" : undefined}
                value={form.password}
                onChange={e => set("password", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Use an app password if your provider supports them.</p>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="enabled">Scheduled backups</Label>
                <p className="text-xs text-muted-foreground">Include this account in automatic syncs.</p>
              </div>
              <Switch id="enabled" checked={form.enabled} onCheckedChange={v => set("enabled", v)} />
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={!canConnect || test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? (
                <Loader2 className="animate-spin" />
              ) : tested ? (
                <CheckCircle2 className="text-green-600" />
              ) : (
                <PlugZap />
              )}
              {tested ? "Connection works" : "Test connection"}
            </Button>
            <Button type="submit" disabled={!canConnect || !form.name || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              {account ? "Save" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
