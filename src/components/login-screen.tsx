import { Loader2, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CenteredCard } from "@/components/vault-screens";
import { api } from "@/lib/api";

export function LoginScreen() {
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api("/api/login", { method: "POST", json: { password } });
      await client.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  return (
    <CenteredCard>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogIn className="size-5" /> Sign in to Mailback
          </CardTitle>
          <CardDescription>Enter the login password of this server.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 py-6">
          {/* Lets password managers file the password under a name */}
          <input type="text" name="username" autoComplete="username" value="mailback" readOnly hidden />
          <div className="space-y-2">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={!password || pending}>
            {pending && <Loader2 className="animate-spin" />} Sign in
          </Button>
        </CardFooter>
      </form>
    </CenteredCard>
  );
}
