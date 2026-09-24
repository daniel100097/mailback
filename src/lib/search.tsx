import MiniSearch, { type AsPlainObject, type Options } from "minisearch";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { aad, fromBase64, open, openJson, seal } from "@/shared/crypto";
import type { SearchDoc } from "@/shared/mail";
import { api, apiBytes, type SearchDocPage } from "./api";
import { useKeyring } from "./vault";

/**
 * Full-text search runs entirely in the browser. The server hands out encrypted per-message search
 * documents; the browser decrypts them, builds a MiniSearch index and stores it back on the server
 * encrypted with the user key, so the next session only has to index new mail.
 */

const INDEX_VERSION = 1;
const PAGE_SIZE = 500;
/** Save progress while building a large index, so a closed tab doesn't lose everything. */
const SAVE_EVERY = 5000;
const REFRESH_INTERVAL_MS = 60_000;

type IndexedDoc = SearchDoc & { id: number; mailboxId: number; receivedAt: string | null };

export type SearchResult = {
  id: number;
  score: number;
  subject: string;
  from: string;
  receivedAt: string | null;
  mailboxId: number;
};

const indexOptions: Options<IndexedDoc> = {
  fields: ["subject", "from", "to", "text", "attachments"],
  storeFields: ["subject", "from", "receivedAt", "mailboxId"],
  extractField: (doc, field) => {
    const value = doc[field as keyof IndexedDoc];
    return Array.isArray(value) ? value.join(" ") : (value as string);
  },
  searchOptions: { prefix: true, fuzzy: 0.2, boost: { subject: 3, from: 2 }, combineWith: "AND" },
};

type StoredIndex = { version: number; lastMessageId: number; index: AsPlainObject };

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export type SearchStatus = {
  state: "loading" | "indexing" | "ready" | "error";
  indexed: number;
  /** Messages not yet indexed */
  remaining: number;
  error?: string;
};

type SearchContextValue = {
  status: SearchStatus;
  /** Increments whenever the index changes. */
  version: number;
  search: (query: string, filter?: { mailboxId?: number }) => SearchResult[];
  /** Index new messages now. */
  refresh: () => void;
  /** Throw the index away and rebuild it, e.g. after mail was deleted. */
  rebuild: () => void;
};

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const keyring = useKeyring();
  const [status, setStatus] = useState<SearchStatus>({ state: "loading", indexed: 0, remaining: 0 });
  const [version, setVersion] = useState(0);

  const index = useRef(new MiniSearch<IndexedDoc>(indexOptions));
  const lastMessageId = useRef(0);
  const loaded = useRef(false);
  const running = useRef(false);
  const again = useRef(false);
  const pendingReset = useRef(false);

  const save = useCallback(async () => {
    const stored: StoredIndex = {
      version: INDEX_VERSION,
      lastMessageId: lastMessageId.current,
      index: index.current.toJSON(),
    };
    const sealed = await seal(keyring.userKey, await gzip(JSON.stringify(stored)), aad.searchIndex);
    await fetch("/api/search-index", { method: "PUT", body: sealed }).then(res => {
      if (!res.ok) throw new Error(`Saving the search index failed: ${res.status}`);
    });
  }, [keyring]);

  const load = useCallback(async () => {
    const sealed = await apiBytes("/api/search-index");
    if (!sealed) return;
    try {
      const stored = JSON.parse(await gunzip(await open(keyring.userKey, sealed, aad.searchIndex))) as StoredIndex;
      if (stored.version !== INDEX_VERSION) return;
      index.current = await MiniSearch.loadJSAsync(stored.index, indexOptions);
      lastMessageId.current = stored.lastMessageId;
    } catch (error) {
      console.warn("Discarding unreadable search index:", error);
    }
  }, [keyring]);

  const catchUp = useCallback(async () => {
    if (pendingReset.current) {
      pendingReset.current = false;
      index.current = new MiniSearch<IndexedDoc>(indexOptions);
      lastMessageId.current = 0;
      setVersion(v => v + 1);
    }

    let unsaved = 0;
    let remaining = Infinity;
    while (remaining > 0) {
      const page = await api<SearchDocPage>(`/api/search-docs?after=${lastMessageId.current}&limit=${PAGE_SIZE}`);
      remaining = page.remaining - page.docs.length;
      if (page.docs.length === 0) break;
      setStatus({ state: "indexing", indexed: index.current.documentCount, remaining: page.remaining });

      const docs = await Promise.all(
        page.docs.map(async doc => {
          try {
            const key = await keyring.dataKey(doc.dataKeyId, page.keys[doc.dataKeyId]);
            const searchDoc = await openJson<SearchDoc>(key, fromBase64(doc.searchDoc), aad.searchDoc(doc));
            return { ...searchDoc, id: doc.id, mailboxId: doc.mailboxId, receivedAt: doc.receivedAt };
          } catch (error) {
            console.warn(`Could not decrypt search document of message ${doc.id}:`, error);
            return null;
          }
        }),
      );
      for (const doc of docs) {
        if (doc && !index.current.has(doc.id)) index.current.add(doc);
      }
      lastMessageId.current = page.docs.at(-1)!.id;
      unsaved += page.docs.length;
      setVersion(v => v + 1);

      if (unsaved >= SAVE_EVERY) {
        await save();
        unsaved = 0;
      }
    }
    if (unsaved > 0) await save();
    setStatus({ state: "ready", indexed: index.current.documentCount, remaining: 0 });
  }, [keyring, save]);

  const refresh = useCallback(() => {
    // Only one pass at a time; refreshes requested meanwhile collapse into one more pass.
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    (async () => {
      do {
        again.current = false;
        try {
          if (!loaded.current) {
            await load();
            loaded.current = true;
            setVersion(v => v + 1);
          }
          await catchUp();
        } catch (error) {
          setStatus(s => ({ ...s, state: "error", error: (error as Error).message }));
        }
      } while (again.current);
      running.current = false;
    })();
  }, [load, catchUp]);

  const rebuild = useCallback(() => {
    pendingReset.current = true;
    refresh();
  }, [refresh]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const search = useCallback((query: string, filter?: { mailboxId?: number }) => {
    if (!query.trim()) return [];
    const results = index.current.search(query, {
      filter: filter?.mailboxId === undefined ? undefined : r => r.mailboxId === filter.mailboxId,
    });
    return results.slice(0, 200).map(r => ({
      id: r.id as number,
      score: r.score,
      subject: r.subject as string,
      from: r.from as string,
      receivedAt: r.receivedAt as string | null,
      mailboxId: r.mailboxId as number,
    }));
  }, []);

  const value = useMemo(
    () => ({ status, version, search, refresh, rebuild }),
    [status, version, search, refresh, rebuild],
  );
  return <SearchContext value={value}>{children}</SearchContext>;
}

export function useSearch(): SearchContextValue {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error("useSearch must be used inside SearchProvider");
  return ctx;
}
