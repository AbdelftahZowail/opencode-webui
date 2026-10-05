/**
 * File shelf — browser data layer (no JSX, no components).
 *
 * Mirrors the core proxy stratum in `server/shelf.ts`: one listing endpoint and
 * the FROZEN `/api/shelf/file/` URL prefix. Everything here is same-origin
 * `/api`, so the session cookie rides along automatically.
 */

/** File URLs live here — frozen, shared with server/shelf.ts. */
export const SHELF_FILE_PREFIX = "/api/shelf/file/";
export const SHELF_LIST_PATH = "/api/shelf/list";

export type ShelfKind = "image" | "video" | "audio" | "pdf" | "text" | "other";

export interface ShelfEntry {
  name: string;
  path: string;
  kind: ShelfKind | "dir";
  size: number;
  mtime: number;
  mime: string | null;
  /** Directory entries only: number of visible children. */
  count?: number;
}

export interface ShelfListResponse {
  ok: boolean;
  root: string;
  /** Current directory ("" at the root). */
  dir: string;
  /** Parent directory, or null at the root. */
  parent: string | null;
  /** Active server-side search needle, or null. */
  search: string | null;
  count: number;
  truncated: boolean;
  /** Current directory's immediate children (or the search matches). */
  entries: ShelfEntry[];
  /** Flat recursive file listing (capped) — used for existence checks. */
  items: ShelfEntry[];
  /** False when the root is missing or refused by the dedicated-root guard. */
  exists: boolean;
  maxEntries: number;
  /** Null unless the public shelf is explicitly enabled. */
  publicRoot: string | null;
  publicPrefix: string | null;
  publicItems: ShelfEntry[];
  error?: string;
}

/** Percent-encode each segment so `/` remains the path separator. */
export function encodeShelfPath(path: string): string {
  return path
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");
}

/** Root-relative URL for a shelf file (the frozen prefix). */
export function shelfFileUrl(path: string, opts: { download?: boolean } = {}): string {
  const url = `${SHELF_FILE_PREFIX}${encodeShelfPath(path)}`;
  return opts.download ? `${url}?dl=1` : url;
}

/** Absolute URL for copying into chat/markdown. */
export function shelfAbsoluteUrl(path: string, opts: { download?: boolean } = {}): string {
  try {
    return new URL(shelfFileUrl(path, opts), window.location.origin).href;
  } catch {
    return shelfFileUrl(path, opts);
  }
}

/** Public (Caddy-served) URL: `<prefix>/<path>`. */
export function publicShelfUrl(prefix: string, path: string): string {
  const base = prefix.replace(/\/+$/, "");
  return `${base}/${encodeShelfPath(path)}`;
}

/** Fetch the listing for a directory, or a server-side search when `q` is set. */
export async function fetchShelf(opts: {
  dir?: string;
  q?: string;
  flat?: boolean;
  signal?: AbortSignal;
}): Promise<ShelfListResponse> {
  const params = new URLSearchParams();
  if (opts.dir) params.set("dir", opts.dir);
  if (opts.q != null && opts.q !== "") params.set("q", opts.q);
  // `items` (the recursive flat walk) is unused by the UI, so opt IN rather
  // than pay for a full-tree walk on every directory listing.
  if (opts.flat !== true) params.set("flat", "0");
  const qs = params.toString();
  const res = await fetch(`${SHELF_LIST_PATH}${qs ? `?${qs}` : ""}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  const body = (await res.json().catch(() => null)) as ShelfListResponse | null;
  if (!res.ok || !body || body.ok !== true) {
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function formatSize(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatMtime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function kindLabel(kind: ShelfEntry["kind"]): string {
  switch (kind) {
    case "dir":
      return "Folder";
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    default:
      return "File";
  }
}

/** Media kinds that can render in the inline preview. */
export function isPreviewable(kind: ShelfEntry["kind"]): boolean {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "text";
}
