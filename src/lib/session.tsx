import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { api, UNAUTHORIZED_EVENT, type Session } from "./api";

type SessionContextValue = { loginRequired: boolean; readOnly: boolean; logout: () => Promise<void> };

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSessionQuery() {
  return useQuery({ queryKey: ["session"], queryFn: () => api<Session>("/api/session"), staleTime: Infinity });
}

/** Provides logout, and re-checks the session whenever an API call comes back 401. */
export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  const client = useQueryClient();

  useEffect(() => {
    const onUnauthorized = () => client.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [client]);

  const logout = useCallback(async () => {
    await api("/api/logout", { method: "POST" });
    // Showing the login unmounts the app, which drops the unlocked keys; then forget all cached data.
    client.setQueryData<Session>(["session"], old => old && { ...old, authenticated: false });
    client.removeQueries({ predicate: query => query.queryKey[0] !== "session" });
  }, [client]);

  return (
    <SessionContext value={{ loginRequired: session.required, readOnly: session.readOnly, logout }}>{children}</SessionContext>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
