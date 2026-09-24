import { Copy, Download, KeyRound, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { downloadBlob } from "@/lib/format";
import { useVault } from "@/lib/vault";
import { createVault, type VaultPayload } from "@/shared/crypto";

const MIN_PASSPHRASE_LENGTH = 10;

export function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-lg">{children}</Card>
    </div>
  );
}

export function VaultSetup() {
  const { saveVault } = useVault();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ payload: VaultPayload; recoveryKey: string } | null>(null);
  const [savedRecoveryKey, setSavedRecoveryKey] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const mismatch = confirm.length > 0 && passphrase !== confirm;
  const tooShort = passphrase.length < MIN_PASSPHRASE_LENGTH;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (tooShort || passphrase !== confirm) return;
    setCreating(true);
    try {
      setCreated(await createVault(passphrase));
    } catch (error) {
      toast.error(`Could not create keys: ${(error as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function finish() {
    if (!created) return;
    setFinishing(true);
    try {
      await saveVault(created.payload, created.recoveryKey);
    } catch (error) {
      toast.error((error as Error).message);
      setFinishing(false);
    }
  }

  if (created) {
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5" /> Save your recovery key
          </CardTitle>
          <CardDescription>
            If you forget your passphrase, this key is the only way to read your backups. Mailback cannot recover
            them for you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea readOnly wrap="off" value={created.recoveryKey} className="h-40 font-mono text-xs" />
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => downloadBlob(created.recoveryKey, "mailback-recovery-key.pem", "application/x-pem-file")}
            >
              <Download /> Download
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                navigator.clipboard.writeText(created.recoveryKey).then(() => toast.success("Copied to clipboard"))
              }
            >
              <Copy /> Copy
            </Button>
          </div>
          <Alert>
            <ShieldCheck />
            <AlertTitle>Keep it offline</AlertTitle>
            <AlertDescription>
              Store it in a password manager or print it. Anyone with this key can read all backed-up mail.
            </AlertDescription>
          </Alert>
          <div className="flex items-center gap-2">
            <Checkbox id="saved" checked={savedRecoveryKey} onCheckedChange={v => setSavedRecoveryKey(v === true)} />
            <Label htmlFor="saved">I have stored my recovery key in a safe place</Label>
          </div>
        </CardContent>
        <CardFooter>
          <Button className="w-full" disabled={!savedRecoveryKey || finishing} onClick={finish}>
            {finishing && <Loader2 className="animate-spin" />} Finish setup
          </Button>
        </CardFooter>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <form onSubmit={create}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="size-5" /> Set up encryption
          </CardTitle>
          <CardDescription>
            Mailback encrypts every message it backs up. Your browser creates a key pair: the server only gets the
            public key, so it can store new mail but never read it again. Only this passphrase unlocks your mail.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 py-6">
          <div className="space-y-2">
            <Label htmlFor="passphrase">Passphrase</Label>
            <Input
              id="passphrase"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">At least {MIN_PASSPHRASE_LENGTH} characters. Longer is better.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm passphrase</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
            {mismatch && <p className="text-xs text-destructive">Passphrases don't match</p>}
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={creating || tooShort || passphrase !== confirm}>
            {creating ? (
              <>
                <Loader2 className="animate-spin" /> Generating keys…
              </>
            ) : (
              "Create keys"
            )}
          </Button>
        </CardFooter>
      </form>
    </CenteredCard>
  );
}

export function VaultUnlock() {
  const { unlock, unlockWithRecoveryKey } = useVault();
  const [mode, setMode] = useState<"passphrase" | "recovery">("passphrase");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "passphrase") await unlock(secret);
      else await unlockWithRecoveryKey(secret);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(m => (m === "passphrase" ? "recovery" : "passphrase"));
    setSecret("");
    setError(null);
  }

  return (
    <CenteredCard>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="size-5" /> Unlock Mailback
          </CardTitle>
          <CardDescription>
            Your mail is decrypted in this browser only. Keys are kept in memory and forgotten when you lock, reload or
            close the tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 py-6">
          {mode === "passphrase" ? (
            <>
              <Label htmlFor="passphrase">Passphrase</Label>
              <Input
                id="passphrase"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={secret}
                onChange={e => setSecret(e.target.value)}
                aria-invalid={!!error}
              />
            </>
          ) : (
            <>
              <Label htmlFor="recovery">Recovery key</Label>
              <Textarea
                id="recovery"
                className="h-40 font-mono text-xs"
                placeholder="-----BEGIN MAILBACK PRIVATE KEY-----"
                value={secret}
                onChange={e => setSecret(e.target.value)}
                aria-invalid={!!error}
              />
              <Input
                type="file"
                accept=".pem,text/plain"
                onChange={async e => {
                  const file = e.target.files?.[0];
                  if (file) setSecret(await file.text());
                }}
              />
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex-col gap-2">
          <Button type="submit" className="w-full" disabled={busy || !secret}>
            {busy && <Loader2 className="animate-spin" />} Unlock
          </Button>
          <Button type="button" variant="link" size="sm" onClick={switchMode}>
            {mode === "passphrase" ? "Use recovery key instead" : "Use passphrase instead"}
          </Button>
        </CardFooter>
      </form>
    </CenteredCard>
  );
}
