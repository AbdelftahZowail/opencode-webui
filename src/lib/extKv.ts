/**
 * Browser-side per-extension KV (spec §10 `kv` surface).
 *
 * One small persistent store per extension id — the browser equivalent of
 * the proxy's KV (`server/ext/kv.ts`), so DOM/browser extensions don't each
 * roll their own localStorage plumbing. Backed by localStorage with an
 * in-memory fallback (private mode / quota errors); values are JSON.
 *
 * Shipped (in-repo) extensions import `extKv` directly; external bundles
 * reach the identical store through the bridge (`api.kv.forExt(id)`).
 */

const PREFIX = "webui.extkv.";

export interface ExtKVStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
  clear(): void;
}

const memoryFallback = new Map<string, Map<string, string>>();

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readRaw(extID: string, key: string): string | undefined {
  if (storageAvailable()) {
    try {
      return localStorage.getItem(PREFIX + extID + "." + key) ?? undefined;
    } catch {
      /* fall through to memory */
    }
  }
  return memoryFallback.get(extID)?.get(key);
}

function writeRaw(extID: string, key: string, raw: string): void {
  if (storageAvailable()) {
    try {
      localStorage.setItem(PREFIX + extID + "." + key, raw);
      return;
    } catch {
      /* fall through to memory */
    }
  }
  let bucket = memoryFallback.get(extID);
  if (!bucket) {
    bucket = new Map();
    memoryFallback.set(extID, bucket);
  }
  bucket.set(key, raw);
}

function deleteRaw(extID: string, key: string): void {
  if (storageAvailable()) {
    try {
      localStorage.removeItem(PREFIX + extID + "." + key);
    } catch {
      /* still clear the fallback below */
    }
  }
  memoryFallback.get(extID)?.delete(key);
}

/** The persistent store for one extension id. */
export function extKv(extID: string): ExtKVStore {
  return {
    get<T = unknown>(key: string): T | undefined {
      const raw = readRaw(extID, key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    set(key: string, value: unknown): void {
      try {
        writeRaw(extID, key, JSON.stringify(value));
      } catch {
        /* unserializable — never throw into the extension */
      }
    },
    delete(key: string): void {
      deleteRaw(extID, key);
    },
    keys(): string[] {
      const out = new Set<string>();
      if (storageAvailable()) {
        try {
          const prefix = PREFIX + extID + ".";
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(prefix)) out.add(k.slice(prefix.length));
          }
        } catch {
          /* memory fallback below still reports */
        }
      }
      for (const k of memoryFallback.get(extID)?.keys() ?? []) out.add(k);
      return [...out];
    },
    clear(): void {
      for (const k of this.keys()) deleteRaw(extID, k);
    },
  };
}
