/**
 * Phase C — USER extension dirs.
 *
 * Plugins ship browser halves discovered through the engine's /api/plugin
 * list (see index.ts). This module adds the user's own drop-in dirs, scanned
 * straight from disk with NO engine involvement:
 *
 *   ~/.config/opencode/webui-extensions/<name>/main.tsx   (global)
 *   <cwd>/.opencode/webui-extensions/<name>/main.tsx      (per project)
 *
 * They ride the exact same pipeline as plugin UIs — mtime cache-busting and
 * Bun.build bundling via bundleUIEntry() in index.ts — so a user extension
 * is just `{ id, url, source: "user:<path>" }` appended to the existing
 * GET /api/webui/extensions manifest. Discovery is cached 5s, mirroring the
 * plugin discovery pattern.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UIEntry = { id: string; entry: string; mtimeMs: number; source?: string };

export const USER_EXT_LIST_TTL_MS = 5_000;

export function globalUserExtensionsDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "opencode", "webui-extensions");
}

export function projectUserExtensionsDir(): string {
  return join(process.cwd(), ".opencode", "webui-extensions");
}

const warned = new Set<string>();

/** Console.warn at most once per key per process — discovery re-runs every 5s. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[webui] ${message}`);
}

let cache: { at: number; entries: UIEntry[] } | null = null;

/**
 * User UI entries, global root first. Absent roots and unreadable entries are
 * skipped silently (that is the normal case); duplicate ids across roots warn
 * once and keep the first.
 */
export function discoverUserUIEntries(): UIEntry[] {
  const now = Date.now();
  if (cache && now - cache.at < USER_EXT_LIST_TTL_MS) return cache.entries;

  const entries: UIEntry[] = [];
  const seen = new Set<string>();
  for (const root of [globalUserExtensionsDir(), projectUserExtensionsDir()]) {
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // absent root is the normal case
    }
    for (const name of names) {
      if (seen.has(name)) {
        warnOnce(`user-dup:${name}`, `user extension "${name}" exists in two roots — keeping the first`);
        continue;
      }
      const entry = join(root, name, "main.tsx");
      try {
        if (!existsSync(entry)) continue;
        entries.push({
          id: name,
          entry,
          mtimeMs: statSync(entry).mtimeMs,
          source: `user:${entry}`,
        });
        seen.add(name);
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  cache = { at: now, entries };
  return entries;
}
