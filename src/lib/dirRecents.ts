/**
 * Directory path helpers + per-project recents for the Composer's directory
 * completion (parity R8).
 *
 * The path maths (`expandHome` / `contractHome` / `normalizePath` /
 * `resolveDirectory` / `rankDirectories` / `fuzzyMatch`) is PURE — no DOM, no
 * localStorage, no React, and deliberately no import from `store.ts` — so it
 * is unit-testable. Persistence (the recents list) mirrors
 * `lib/frecencyStore.ts`: one localStorage key, per-project buckets, a cap,
 * storage failures degrade to "doesn't persist".
 *
 * v2 reference: `prompt/directory-completion.ts`, `prompt/directory-recents.ts`
 * and `prompt/autocomplete.tsx:740-760`. The v2 source was unavailable while
 * this was built, so the behaviour is taken from `docs/plans/parity.md` §5 R8:
 * `~`, `~/`, `../` and absolute paths; per-project recents (≤10) prepended;
 * a destructive `ctrl+d` confirm clears recents; `tab` expands the highlighted
 * completion.
 */

/** v2 shows at most ten directory suggestions in the completion list. */
export const MAX_DIR_RECENTS = 10;

const STORAGE_KEY = "webui.dirRecents";
/** Cap the number of projects tracked so throwaway repos can't grow storage. */
const MAX_PROJECTS = 20;

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/**
 * Rough, dependency-free match score for one typed query against several
 * candidate strings (display path + basename). 0 = no match. Ordering:
 * exact > prefix > path-segment start > substring > subsequence.
 */
export function fuzzyMatch(query: string, ...targets: string[]): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  let best = 0;
  for (const target of targets) {
    const t = target.toLowerCase();
    if (!t) continue;
    if (t === q) best = Math.max(best, 1000);
    else if (t.startsWith(q)) best = Math.max(best, 700);
    else if (t.includes(`/${q}`)) best = Math.max(best, 500);
    else if (t.includes(q)) best = Math.max(best, 300);
    else if (isSubsequence(q, t)) best = Math.max(best, 100);
  }
  return best;
}

/**
 * Lexically normalize a path: drop `.` segments, resolve `..` against the
 * preceding segment, collapse duplicate slashes. Preserves a leading `/`
 * (absolute) and a leading `~` (home marker — `..` never pops it). This is
 * purely textual (no filesystem / symlink resolution), which is what the
 * completion needs.
 */
export function normalizePath(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const absolute = raw.startsWith("/");
  const stack: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = stack[stack.length - 1];
      const isHome = !!last && last.startsWith("~");
      if (stack.length > 0 && last !== ".." && !isHome) stack.pop();
      else if (!absolute) stack.push("..");
      continue;
    }
    stack.push(segment);
  }
  const joined = stack.join("/");
  if (absolute) return joined ? `/${joined}` : "/";
  return joined;
}

/**
 * Expand a leading `~` / `~/` using `home`. Other paths pass through
 * unchanged. Without a known `home` the marker is left literal so the caller
 * can still display/round-trip it.
 */
export function expandHome(input: string, home?: string): string {
  const raw = (input ?? "").trim();
  if (!raw || !home) return raw;
  if (raw === "~") return home.replace(/\/+$/, "");
  if (raw.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${raw.slice(2)}`;
  return raw;
}

/** Inverse of `expandHome`: a path under `home` collapses to `~/…`. */
export function contractHome(path: string, home?: string): string {
  const raw = (path ?? "").trim();
  if (!raw || !home) return raw;
  const h = home.replace(/\/+$/, "");
  if (!h) return raw;
  if (raw === h) return "~";
  if (raw.startsWith(`${h}/`)) return `~/${raw.slice(h.length + 1)}`;
  return raw;
}

/** The trailing segment (basename) of a path; `""` when the path ends in `/`. */
export function lastSegment(path: string): string {
  const trimmed = (path ?? "").replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** The directory portion of a path prefix, INCLUDING its trailing `/`. */
export function dirPrefix(path: string): string {
  const idx = (path ?? "").lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx + 1);
}

/** True when a string is meant as a directory path (`~`, `~/`, `/`, `./`, `../`). */
export function isDirectoryQuery(query: string): boolean {
  return /^\s*(~(?:\/|$)|\.\.?\/|\/)/.test(query ?? "");
}

/**
 * Resolve a user-typed directory into an absolute, normalized path:
 * expand `~` with `home`, join a relative path onto `base`, then normalize
 * (`..`/`.`/duplicate slashes). Returns `""` for empty input.
 */
export function resolveDirectory(input: string, opts: { home?: string; base?: string } = {}): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  let path = expandHome(raw, opts.home);
  if (!path.startsWith("/")) {
    const base = (opts.base ?? "").trim();
    if (base.startsWith("/")) path = `${base.replace(/\/+$/, "")}/${path}`;
  }
  return normalizePath(path);
}

/**
 * Rank directory candidates for a typed prefix: matching recents first (in
 * their stored order), then the remaining candidates by fuzzy score. Deduped,
 * capped at `limit`. Comparison uses the contracted (`~/…`) display form so a
 * `~/`-typed query matches recents too.
 */
export function rankDirectories(
  query: string,
  opts: { recents?: string[]; candidates?: string[]; home?: string; limit?: number } = {},
): string[] {
  const limit = opts.limit ?? MAX_DIR_RECENTS;
  const raw = (query ?? "").trim();
  const q = raw.toLowerCase();
  const home = opts.home;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string) => {
    const norm = normalizePath(p);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  const matches = (p: string): boolean => {
    if (!q) return true;
    const display = contractHome(p, home).toLowerCase();
    const name = lastSegment(p).toLowerCase();
    if (raw.endsWith("/")) return display.startsWith(q) || display === q.slice(0, -1);
    return fuzzyMatch(raw, display, name) > 0;
  };
  for (const recent of opts.recents ?? []) if (matches(recent)) add(recent);
  for (const candidate of opts.candidates ?? []) if (matches(candidate)) add(candidate);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Persistence — per-project recents (the only impure part of this module)
// ---------------------------------------------------------------------------

type ByProject = Record<string, string[]>;

function load(): ByProject {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ByProject = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        out[key] = value.filter((v): v is string => typeof v === "string").slice(0, MAX_DIR_RECENTS);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: ByProject): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable (private mode/quota) — recents just don't persist */
  }
}

/** The recents for a project, newest first (≤ `MAX_DIR_RECENTS`). */
export function loadDirRecents(project?: string): string[] {
  return load()[project ?? ""] ?? [];
}

/** Record a freshly used directory for a project (dedupe + move to front). */
export function recordDirRecent(project: string | undefined, directory: string): void {
  const norm = normalizePath(directory);
  if (!norm) return;
  const key = project ?? "";
  const map = load();
  const prev = map[key] ?? [];
  const next = [norm, ...prev.filter((d) => d !== norm)].slice(0, MAX_DIR_RECENTS);
  // Re-insert the touched project first, then drop the oldest projects.
  const rest = Object.entries(map).filter(([k]) => k !== key);
  write(Object.fromEntries([[key, next], ...rest].slice(0, MAX_PROJECTS)));
}

/** Destructive: wipe a project's recents (the `ctrl+d` confirm target). */
export function clearDirRecents(project?: string): void {
  const key = project ?? "";
  const map = load();
  if (!(key in map)) return;
  delete map[key];
  write(map);
}
