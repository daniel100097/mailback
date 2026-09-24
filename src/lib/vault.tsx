import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  exportAesKey,
  toBase64,
  unlockVault,
  unlockVaultWithRecoveryKey,
  unwrapAesKey,
  type UnlockedVault,
  type VaultPayload,
} from "@/shared/crypto";
import { api, ApiError, type VaultResponse, type WrappedKeys } from "./api";

/** Lock the vault after this long without user activity. */
const IDLE_LOCK_MS = 30 * 60_000;

/**
 * The unlocked keys. Lives only in memory: reloading the page or locking drops it. The private key
 * is non-extractable, so not even code running in this page can export it.
 */
export class Keyring {
  private dataKeys = new Map<number, Promise<CryptoKey>>();

  constructor(
    readonly privateKey: CryptoKey,
    readonly userKey: CryptoKey,
  ) {}

  /** Unwrap (and cache) a data key. */
  dataKey(id: number, wrapped: string | undefined): Promise<CryptoKey> {
    let key = this.dataKeys.get(id);
    if (!key) {
      if (!wrapped) return Promise.reject(new Error(`Data key ${id} is missing`));
      key = unwrapAesKey(this.privateKey, wrapped);
      key.catch(() => this.dataKeys.delete(id));
      this.dataKeys.set(id, key);
    }
    return key;
  }

  /**
   * Unwrap data keys as raw bytes for a server task. This is the only way key material leaves the
   * browser, and it is limited to the keys the task needs.
   */
  async exportDataKeys(wrapped: WrappedKeys): Promise<Record<string, string>> {
    const entries = await Promise.all(
      Object.entries(wrapped).map(async ([id, key]) => {
        const unwrapped = await unwrapAesKey(this.privateKey, key, true);
        return [id, toBase64(await exportAesKey(unwrapped))] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}

type VaultState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "setup" }
  | { status: "locked"; vault: VaultPayload }
  | { status: "unlocked"; vault: VaultPayload; keyring: Keyring };

type VaultContextValue = {
  state: VaultState;
  reload: () => Promise<void>;
  /** Store a newly created vault on the server and unlock it. */
  saveVault: (payload: VaultPayload, recoveryKey: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  unlockWithRecoveryKey: (pem: string) => Promise<void>;
  lock: () => void;
};

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<VaultState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      const res = await api<VaultResponse>("/api/vault");
      setState(res.configured ? { status: "locked", vault: res.vault } : { status: "setup" });
    } catch (error) {
      setState({ status: "error", error: (error as Error).message });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const unlocked = useCallback(
    (vault: VaultPayload, keys: UnlockedVault) =>
      setState({ status: "unlocked", vault, keyring: new Keyring(keys.privateKey, keys.userKey) }),
    [],
  );

  const vault = state.status === "locked" || state.status === "unlocked" ? state.vault : null;

  const unlock = useCallback(
    async (passphrase: string) => {
      if (!vault) throw new Error("No vault");
      unlocked(vault, await unlockVault(vault, passphrase));
    },
    [vault, unlocked],
  );

  const unlockWithRecoveryKey = useCallback(
    async (pem: string) => {
      if (!vault) throw new Error("No vault");
      unlocked(vault, await unlockVaultWithRecoveryKey(vault, pem));
    },
    [vault, unlocked],
  );

  const saveVault = useCallback(
    async (payload: VaultPayload, recoveryKey: string) => {
      try {
        await api("/api/vault", { method: "POST", json: payload });
      } catch (error) {
        // Someone else set up encryption in the meantime; theirs wins.
        if (error instanceof ApiError && error.status === 409) await reload();
        throw error;
      }
      unlocked(payload, await unlockVaultWithRecoveryKey(payload, recoveryKey));
    },
    [reload, unlocked],
  );

  const lock = useCallback(() => {
    // Drop everything decrypted along with the keys.
    queryClient.clear();
    setState(s => (s.status === "unlocked" ? { status: "locked", vault: s.vault } : s));
  }, [queryClient]);

  // Auto-lock when idle.
  const isUnlocked = state.status === "unlocked";
  useEffect(() => {
    if (!isUnlocked) return;
    let lastActivity = Date.now();
    const touch = () => (lastActivity = Date.now());
    const events = ["pointerdown", "keydown", "wheel", "pointermove"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_LOCK_MS) lock();
    }, 30_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      clearInterval(timer);
    };
  }, [isUnlocked, lock]);

  return (
    <VaultContext value={{ state, reload, saveVault, unlock, unlockWithRecoveryKey, lock }}>{children}</VaultContext>
  );
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used inside VaultProvider");
  return ctx;
}

/** The keyring. Only use inside components rendered while the vault is unlocked. */
export function useKeyring(): Keyring {
  const { state } = useVault();
  if (state.status !== "unlocked") throw new Error("Vault is locked");
  return state.keyring;
}
