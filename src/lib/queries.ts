import { useQuery } from "@tanstack/react-query";
import { api, type Account, type Mailbox, type Stats, type Task } from "./api";

export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/accounts"),
    // Poll quickly while a sync runs, slowly otherwise (scheduled syncs start on their own).
    refetchInterval: query => (query.state.data?.some(a => a.syncing) ? 2000 : 30_000),
  });
}

export function useMailboxes() {
  return useQuery({ queryKey: ["mailboxes"], queryFn: () => api<Mailbox[]>("/api/mailboxes") });
}

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: () => api<Stats>("/api/stats") });
}

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => api<Task[]>("/api/tasks"),
    refetchInterval: query => (query.state.data?.some(t => t.status === "running") ? 1000 : 15_000),
  });
}
