/**
 * Extension folder discovery — ONE loader, THREE sources (spec §4, §6, §11.3).
 *
 * Sources, highest precedence first (same id = same swap point, higher wins):
 *   1. user:    ~/.config/opencode/webui-extensions/<name>/   (global)
 *   2. project: <cwd>/.opencode/webui-extensions/<name>/      (per project)
 *   3. shipped: <app>/webui-extensions/<name>/                (ours, updates with the app)
 *
 * One extension = one folder. Gating is owned by the folder itself:
 * presence = installed; manifest.json `disabled: true` = paused; delete/move
 * the folder to uninstall. No config.ts list, no per-browser localStorage.
 *
 * Folder anatomy (new format; legacy `main.tsx`-only folders still load):
 *   manifest.json   { id?, name?, version?, description?, disabled? }
 *   index.tsx       browser stratum entry (preferred)
 *   main.tsx        legacy browser entry (fallback)
 *   dom.ts          DOM stratum entry (spec §7 — post-render DOM changes)
 *
 * They ride the same pipeline as plugin UIs — mtime cache-busting and
 * Bun.build bundling via bundleUIEntry() in index.ts — so an extension is
 * just `{ id, url?, domUrl?, source }` (or `{ id, disabled: true, source }`
 * when paused) in the GET /api/webui/extensions manifest. A dom-only folder
 * (no index/main entry) still lists with only `domUrl`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type UIEntry = {
  id: string;
  /** Browser-stratum bundle entry file; "" when none exists (or disabled). */
  entry: string;
  mtimeMs: number;
  /** DOM-stratum bundle entry (`dom.ts`); absent when the folder has none. */
  domEntry?: string;
  domMtimeMs?: number;
  source?: string;
  /** manifest.json `disabled: true` — paused, never bundled or imported. */
  disabled?: boolean;
  /** Which of the three sources won for this id. */
  origin?: "user" | "project" | "shipped";
};

export const USER_EXT_LIST_TTL_MS = 5_000;

export function globalUserExtensionsDir(): string {
  // WEBUI_EXTENSION_DIR replaces BOTH roots (global + project) with one
  // directory — the sandbox sets this to its scratch dir so WIP extensions
  // stay invisible to the main instance until copied out.
  const override = process.env.WEBUI_EXTENSION_DIR;
  if (override && override.length > 0) return override;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "opencode", "webui-extensions");
}

export function projectUserExtensionsDir(): string | null {
  if (process.env.WEBUI_EXTENSION_DIR) return null; // sandbox: scratch only
  return join(process.cwd(), ".opencode", "webui-extensions");
}

/** Shipped extensions live next to the app and update with it. Resolved from
 * this module's location (not cwd — the proxy may be launched from any
 * project directory; only the PROJECT source is cwd-relative). */
export function shippedExtensionsDir(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "webui-extensions");
  } catch {
    return join(process.cwd(), "webui-extensions");
  }
}

/** Every source root the proxy watches (existing or not — watchers attach lazily). */
export function extensionSourceRoots(): string[] {
  const roots = [globalUserExtensionsDir(), projectUserExtensionsDir(), shippedExtensionsDir()];
  return roots.filter((r): r is string => !!r);
}

const warned = new Set<string>();

/** Console.warn at most once per key per process — discovery re-runs often. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[webui] ${message}`);
}

let cache: { at: number; entries: UIEntry[] } | null = null;

/** Drop the discovery cache so the next read re-scans disk (watcher path). */
export function invalidateExtensionCache(): void {
  cache = null;
}

function readManifest(dir: string): { id?: unknown; disabled?: unknown } | null {
  try {
    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as { id?: unknown; disabled?: unknown };
    return null;
  } catch {
    return null; // absent or unreadable — legacy folder, id falls back to dir name
  }
}

/** DOM-stratum entry: exactly `dom.ts` — one method per concern. */
function folderDomEntry(dir: string): string | null {
  const candidate = join(dir, "dom.ts");
  try {
    if (existsSync(candidate)) return candidate;
  } catch {
    /* unreadable — no DOM stratum */
  }
  return null;
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null; // vanished mid-scan
  }
}
/** Preferred-first browser entry candidates for one extension folder. */
function folderEntry(dir: string): string | null {
  for (const name of ["index.tsx", "index.ts", "main.tsx", "main.ts"]) {
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable — try the next */
    }
  }
  return null;
}

function scanRoot(root: string, origin: UIEntry["origin"], entries: UIEntry[], seen: Set<string>): void {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return; // absent root is the normal case
  }
  for (const name of names.sort()) {
    if (seen.has(name)) {
      warnOnce(
        `ext-dup:${name}`,
        `extension "${name}" shadowed — keeping the higher-precedence copy`,
      );
      continue;
    }
    const dir = join(root, name);
    let manifest: { id?: unknown; disabled?: unknown } | null = null;
    try {
      manifest = readManifest(dir);
    } catch {
      /* unreadable entry — skip */
      continue;
    }
    const id = typeof manifest?.id === "string" && manifest.id.length > 0 ? manifest.id : name;
    if (seen.has(id)) {
      warnOnce(`ext-dup:${id}`, `extension "${id}" shadowed — keeping the higher-precedence copy`);
      continue;
    }
    const disabled = manifest?.disabled === true;
    const entry = disabled ? null : folderEntry(dir);
    const dom = disabled ? null : folderDomEntry(dir);
    // A paused extension needs no entry file; an enabled one without any
    // entry file is skipped silently (mid-write folder, or server-only —
    // note a dom-only folder DOES list, with only `domEntry` set).
    if (!disabled && !entry && !dom) continue;
    let mtimeMs = 0;
    if (entry) {
      const mtime = mtimeOf(entry);
      if (mtime === null) continue; // vanished mid-scan
      mtimeMs = mtime;
    }
    let domEntry: string | undefined;
    let domMtimeMs: number | undefined;
    if (dom) {
      const mtime = mtimeOf(dom);
      if (mtime !== null) {
        domEntry = dom;
        domMtimeMs = mtime;
      }
    }
    entries.push({
      id,
      entry: entry ?? "",
      mtimeMs,
      domEntry,
      domMtimeMs,
      source: `webui-extensions:${dir}`,
      disabled: disabled || undefined,
      origin,
    });
    seen.add(name);
    seen.add(id);
  }
}

/**
 * All three sources merged, user root first. Absent roots and unreadable
 * entries are skipped silently; duplicate ids across roots warn once and
 * keep the higher-precedence copy (user > project > shipped).
 */
export function discoverUserUIEntries(): UIEntry[] {
  const now = Date.now();
  if (cache && now - cache.at < USER_EXT_LIST_TTL_MS) return cache.entries;

  const entries: UIEntry[] = [];
  const seen = new Set<string>();
  scanRoot(globalUserExtensionsDir(), "user", entries, seen);
  const projectRoot = projectUserExtensionsDir();
  if (projectRoot) scanRoot(projectRoot, "project", entries, seen);
  scanRoot(shippedExtensionsDir(), "shipped", entries, seen);
  cache = { at: now, entries };
  return entries;
}
