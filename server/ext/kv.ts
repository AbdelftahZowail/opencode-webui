/**
 * Proxy-stratum KV store (spec §8).
 *
 * One small persistent store service for server extensions — the
 * `~/.dsh/brother-watches.json` equivalent — so each extension doesn't roll
 * its own file I/O. JSON-file backed (per spec: "bun:sqlite or JSON-file"),
 * namespaced per extension id: `kvFor("brother-watcher")` only ever sees
 * its own top-level key.
 *
 * File: `$XDG_STATE_HOME/opencode-webui/ext-kv.json`
 * (default `~/.local/state/opencode-webui/ext-kv.json`).
 *
 * Deliberately tiny: string-keyed JSON values, read-through cache,
 * write-through on every mutation. NOT for high-frequency counters or
 * binary blobs — extensions with those needs get their own file via fs.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ExtKV {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<boolean>;
  all(): Record<string, unknown>;
}

function kvFile(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(state, "opencode-webui", "ext-kv.json");
}

type KVData = Record<string, Record<string, unknown>>;

let cache: KVData | null = null;

function load(): KVData {
  if (cache) return cache;
  try {
    if (existsSync(kvFile())) {
      cache = JSON.parse(readFileSync(kvFile(), "utf8")) as KVData;
    }
  } catch {
    cache = null; // corrupt file: start empty, overwrite on next set
  }
  if (!cache || typeof cache !== "object") cache = {};
  return cache;
}

async function save(data: KVData): Promise<void> {
  mkdirSync(dirname(kvFile()), { recursive: true, mode: 0o700 });
  await Bun.write(kvFile(), JSON.stringify(data, null, 2));
}

/** Namespaced handle for one extension id. */
export function kvFor(extID: string): ExtKV {
  return {
    get<T = unknown>(key: string): T | undefined {
      const ns = load()[extID];
      return ns?.[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      const data = load();
      const ns = data[extID] ?? {};
      ns[key] = value;
      data[extID] = ns;
      await save(data);
    },
    async del(key: string): Promise<boolean> {
      const data = load();
      const ns = data[extID];
      if (!ns || !(key in ns)) return false;
      delete ns[key];
      await save(data);
      return true;
    },
    all(): Record<string, unknown> {
      return { ...(load()[extID] ?? {}) };
    },
  };
}
