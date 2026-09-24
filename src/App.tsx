import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Loader2, Lock, LogOut, Mail, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AccountsPage } from "@/components/accounts-page";
import { ErrorBoundary } from "@/components/error-boundary";
import { LoginScreen } from "@/components/login-screen";
import { MailPage } from "@/components/mail-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { VaultSetup, VaultUnlock } from "@/components/vault-screens";
import { useAccounts } from "@/lib/queries";
import { SearchProvider, useSearch } from "@/lib/search";
import { SessionProvider, useSession, useSessionQuery } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useVault, VaultProvider } from "@/lib/vault";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionGate />
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  );
}

function SessionGate() {
  const session = useSessionQuery();
  if (session.isPending) return <Loader2 className="m-auto mt-[40vh] animate-spin text-muted-foreground" />;
  if (session.isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">Could not reach the server: {session.error.message}</p>
        <Button variant="outline" onClick={() => session.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (session.data.required && !session.data.authenticated) return <LoginScreen />;
  return (
    <SessionProvider session={session.data}>
      <VaultProvider>
        <VaultGate />
      </VaultProvider>
    </SessionProvider>
  );
}

function VaultGate() {
  const { state, reload } = useVault();
  switch (state.status) {
    case "loading":
      return <Loader2 className="m-auto mt-[40vh] animate-spin text-muted-foreground" />;
    case "error":
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3">
          <p className="text-sm text-destructive">Could not reach the server: {state.error}</p>
          <Button variant="outline" onClick={reload}>
            Retry
          </Button>
        </div>
      );
    case "setup":
      return <VaultSetup />;
    case "locked":
      return <VaultUnlock />;
    case "unlocked":
      return (
        <SearchProvider>
          <Shell />
        </SearchProvider>
      );
  }
}

type Page = "mail" | "accounts";

function pageFromHash(): Page {
  return location.hash === "#/accounts" ? "accounts" : "mail";
}

function Shell() {
  const { lock } = useVault();
  const { loginRequired, readOnly, logout } = useSession();
  const [page, setPage] = useState(pageFromHash);
  useSyncWatcher();

  useEffect(() => {
    const onChange = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (to: Page) => (location.hash = `#/${to}`);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <div className="flex items-center gap-2 font-semibold">
          <ArchiveRestore className="size-5" /> Mailback
        </div>
        <nav className="flex gap-1">
          <NavButton active={page === "mail"} onClick={() => navigate("mail")}>
            <Mail /> Mail
          </NavButton>
          <NavButton active={page === "accounts"} onClick={() => navigate("accounts")}>
            <Server /> Accounts
          </NavButton>
        </nav>
        <div className="ml-auto flex items-center gap-1">
          {readOnly && (
            <Badge variant="secondary" title="Mailback never writes to your IMAP servers, so restore is disabled.">
              IMAP read-only
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={lock}>
            <Lock /> Lock
          </Button>
          {loginRequired && (
            <Button variant="ghost" size="sm" onClick={() => logout().catch(error => toast.error(error.message))}>
              <LogOut /> Sign out
            </Button>
          )}
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <ErrorBoundary key={page}>
          {page === "mail" ? <MailPage onManageAccounts={() => navigate("accounts")} /> : <AccountsPage />}
        </ErrorBoundary>
      </main>
    </div>
  );
}

function NavButton({ active, ...props }: { active: boolean } & React.ComponentProps<typeof Button>) {
  return <Button variant="ghost" size="sm" className={cn(active && "bg-accent")} {...props} />;
}

/** Refresh folders, stats and the search index while and after syncs run. */
function useSyncWatcher() {
  const client = useQueryClient();
  const { refresh } = useSearch();
  const accounts = useAccounts();
  const previouslySyncing = useRef(new Set<number>());

  useEffect(() => {
    if (!accounts.data) return;
    const syncing = new Set(accounts.data.filter(a => a.syncing).map(a => a.id));
    const finished = [...previouslySyncing.current].some(id => !syncing.has(id));
    previouslySyncing.current = syncing;

    if (syncing.size > 0 || finished) {
      client.invalidateQueries({ queryKey: ["mailboxes"] });
      client.invalidateQueries({ queryKey: ["stats"] });
    }
    if (finished) {
      client.invalidateQueries({ queryKey: ["messages"] });
      refresh();
    }
  }, [accounts.data, client, refresh]);
}
