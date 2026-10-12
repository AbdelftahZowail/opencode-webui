/**
 * Custom-theme discovery from the engine config directory (parity R12).
 *
 * v2 discovers themes from `<config>/themes/*.json` plus plugin-installed
 * themes (`theme/discovery.ts`). The webui is a browser client, so it reads
 * those files through the engine's own fs routes rather than the host fs:
 *
 *   - `GET /api/config` lists the config documents/directories (we take the
 *     directory entries + the parent of each file entry as candidate roots);
 *   - `GET /api/fs/list` (location-scoped) lists `<root>/themes`;
 *   - `GET /api/fs/read` reads each `.json`.
 *
 * No proxy route is required: verified live against engine 2.0.22 — a JSON
 * file dropped in `~/.config/opencode/themes/` lists and reads through
 * `/api/fs/list?location[directory]=<config>&path=themes` and
 * `/api/fs/read/themes/<file>?location[directory]=<config>`.
 *
 * The file format is not documented (the v2 source package is unavailable), so
 * the parser is deliberately generous: it accepts `{ name, theme|colors|tokens|vars: {…} }`,
 * `{ themes: { <id>: {…} } }`, and a flat `{ "--token": value }` map. Unknown
 * keys are ignored, never fatal. A theme may pin `scheme: "dark"|"light"`.
 *
 * Not covered here (recorded gap): themes a plugin registers in-memory through
 * the engine's plugin API — no engine route exposes those. A plugin that writes
 * its theme JSON into `<config>/themes/` IS discovered.
 */

import { api, type ConfigEntry } from "../api/client";
import { flattenTokenGroups, registerCustomThemes, type Theme, type ThemePinnedScheme } from "../theme/themes";

const CUSTOM_PREFIX = "custom:";
const THEMES_SUBDIR = "themes";

export interface CustomThemeDiscovery {
  /** Themes found (not yet registered). */
  themes: Theme[];
  /** Config directories that were inspected. */
  dirs: string[];
  /** Non-fatal problems (a missing `themes/` dir is not an error). */
  errors: string[];
}

/** `custom:<file-base>` — stable across content edits, keyed by file name. */
export function customThemeId(fileBase: string): string {
  return `${CUSTOM_PREFIX}${fileBase}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Candidate config roots, highest precedence first: directory entries, then
 * the parent of each file/document entry. Deduplicated, order preserved
 * (configGet lists the global config before the project one).
 */
export function configRoots(entries: ConfigEntry[]): string[] {
  const candidates: string[] = [];
  const push = (dir: string) => {
    if (dir && !candidates.includes(dir)) candidates.push(dir);
  };
  for (const entry of entries) {
    if (entry.type === "directory") push(entry.path);
  }
  for (const entry of entries) {
    if (entry.type === "directory") continue;
    if (typeof entry.path === "string") push(dirname(entry.path));
  }
  // Drop any root nested inside another (e.g. a file under a listed dir):
  // shallow-first so the higher-precedence root is the one kept.
  const ordered = [...candidates].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const dir of candidates) {
    if (ordered.some((other) => other !== dir && dir.startsWith(`${other}/`))) continue;
    roots.push(dir);
  }
  return roots;
}

const META_KEYS = new Set([
  "name",
  "label",
  "title",
  "id",
  "scheme",
  "mode",
  "appearance",
  "type",
  "description",
  "version",
  "source",
  "author",
]);

/** Containers a theme's token map may live under. */
const VAR_CONTAINERS = ["theme", "colors", "colours", "tokens", "vars", "values"] as const;

const KNOWN_TOKENS = new Set(flattenTokenGroups());

function normalizeTokenKey(key: string): string {
  return key.startsWith("--") ? key : `--${key}`;
}

/**
 * Extract `--token` entries from a map. `strict` drops keys that are neither
 * `--`-prefixed nor a known token name (a flat document's metadata keys).
 */
function pickVars(map: Record<string, unknown>, strict: boolean): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (META_KEYS.has(key)) continue;
    const token = normalizeTokenKey(key);
    if (strict && !key.startsWith("--") && !KNOWN_TOKENS.has(token)) continue;
    vars[token] = String(value);
  }
  return vars;
}

function readScheme(def: Record<string, unknown>): ThemePinnedScheme {
  const raw = def.scheme ?? def.mode ?? def.appearance;
  return raw === "dark" || raw === "light" ? raw : "auto";
}

function readLabel(def: Record<string, unknown>, fallback: string): string {
  const raw = def.name ?? def.label ?? def.title;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback;
}

/** Parse one theme definition. Returns null when no tokens are found. */
function parseThemeDefinition(
  def: Record<string, unknown>,
  id: string,
  fallbackLabel: string,
): Theme | null {
  let vars: Record<string, string> = {};
  let foundContainer = false;
  for (const container of VAR_CONTAINERS) {
    const nested = def[container];
    if (isRecord(nested)) {
      vars = pickVars(nested, false);
      foundContainer = true;
      break;
    }
  }
  if (!foundContainer) vars = pickVars(def, true);
  if (Object.keys(vars).length === 0) return null;
  return { id, label: readLabel(def, fallbackLabel), vars, scheme: readScheme(def), source: "custom" };
}

/**
 * Parse a theme JSON document. Supports a single theme, a `themes` map, or a
 * flat token map; returns [] for anything unusable (never throws).
 */
export function parseThemeDocument(raw: unknown, fileBase: string): Theme[] {
  if (!isRecord(raw)) return [];
  const fallbackLabel = fileBase.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const map = raw.themes;
  if (isRecord(map)) {
    const out: Theme[] = [];
    for (const [key, value] of Object.entries(map)) {
      if (!isRecord(value)) continue;
      const theme = parseThemeDefinition(value, customThemeId(`${fileBase}/${key}`), key);
      if (theme) out.push(theme);
    }
    return out;
  }

  const single = parseThemeDefinition(raw, customThemeId(fileBase), fallbackLabel);
  return single ? [single] : [];
}

/**
 * Discover custom themes from the engine config dirs. Never throws — a
 * missing `themes/` directory or an unreadable file is collected in `errors`.
 */
export async function discoverCustomThemes(): Promise<CustomThemeDiscovery> {
  const result: CustomThemeDiscovery = { themes: [], dirs: [], errors: [] };

  let entries: ConfigEntry[];
  try {
    entries = await api.configGet();
  } catch (err) {
    result.errors.push(`config: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const roots = configRoots(entries);
  result.dirs = roots;
  const seen = new Set<string>();

  for (const dir of roots) {
    let listing: Awaited<ReturnType<typeof api.fsList>>;
    try {
      listing = await api.fsList({ location: dir, path: THEMES_SUBDIR });
    } catch {
      // No themes/ dir under this root — expected and not an error.
      continue;
    }
    const files = (listing.data ?? []).filter(
      (entry) => entry.type === "file" && entry.path.toLowerCase().endsWith(".json"),
    );
    for (const file of files) {
      const base = baseName(file.path).replace(/\.json$/i, "");
      if (seen.has(base)) continue; // higher-precedence root wins
      seen.add(base);
      try {
        const text = await api.fsRead(file.path, dir);
        const themes = parseThemeDocument(JSON.parse(text) as unknown, base);
        if (themes.length === 0) result.errors.push(`${file.path}: no theme tokens found`);
        else result.themes.push(...themes);
      } catch (err) {
        result.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

/** Discover and register custom themes into the theme engine. */
export async function loadCustomThemes(): Promise<CustomThemeDiscovery> {
  const discovery = await discoverCustomThemes();
  registerCustomThemes(discovery.themes);
  return discovery;
}
