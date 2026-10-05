/**
 * shelf — CORE proxy stratum (SECURITY-CRITICAL).
 *
 * Serves files from ONE dedicated directory on the webui origin, read-only,
 * behind the normal `/api` session-auth gate. Replaces the `file-shelf`
 * extension's `server.ts`.
 *
 * FROZEN INTERFACE (other workers depend on this literally):
 *
 *   GET  /api/shelf/file/<url-encoded/path>   -> the bytes (inert media inline;
 *                                                 ?dl=1 forces a download)
 *   GET  /api/shelf/list[?dir=…][?q=…]        -> JSON listing
 *
 * The file URL prefix `/api/shelf/file/` MUST NOT move.
 *
 * ---------------------------------------------------------------------------
 * THREAT MODEL
 *
 * Served content is UNTRUSTED user/agent files ("drop a file in the folder and
 * share it"). The shelf is reachable through the SAME ORIGIN as the
 * authenticated webui, so the primary risk is stored XSS: a served .html/.svg/
 * .js executing with the webui origin and stealing the session. Secondary:
 * path traversal (encoded / double-encoded / unicode / backslash), symlink
 * escape, TOCTOU (path swapped between check and open), dotfile/secret
 * leakage, unsafe range handling, and accidental public exposure.
 *
 * DEFENSES (defense in depth)
 *   1. AUTH GATE: `handleShelfRequest` MUST be called only after server/index.ts
 *      has run the session-auth gate. It has no credential of its own. There is
 *      no unauthenticated path in this module.
 *   2. DEDICATED ROOT: the root must be a real directory that is NOT `/`,
 *      `$HOME`, the process cwd (the repo), or an ancestor of either — checked
 *      on every request. Serving is strictly read-only (no write route).
 *   3. NO ACTIVE CONTENT: only inert media (images/video/audio/pdf/text) is
 *      inlined. EVERYTHING else — .html, .svg, .xml, .js, .mjs, .css, .wasm,
 *      unknown — is forced to `application/octet-stream` + `Content-Disposition:
 *      attachment`. All responses carry `X-Content-Type-Options: nosniff`,
 *      `Cross-Origin-Resource-Policy: same-origin`, and `Cache-Control: private,
 *      no-store`; the CSP is `default-src 'none'; sandbox; frame-ancestors 'none'`
 *      for everything EXCEPT inert inline media (raster image/video/audio/pdf),
 *      which gets `frame-ancestors 'self'` so the same-origin webui can embed it
 *      (chat preview iframes, shelf viewer — the PDF viewer refuses to render
 *      under the attachment-grade CSP). No CORS headers, ever.
 *   4. PATH CONFINE: the path is percent-decoded EXACTLY ONCE, then every
 *      segment must be a plain name — no `.`, `..`, leading dot (dotfiles),
 *      empty segment, NUL or backslash. `open(2)` is called with `O_NOFOLLOW`
 *      (final-component symlinks are refused), and the OPEN FILE DESCRIPTOR is
 *      verified: `fstat` must say regular file, the fd's real path (via
 *      `/proc/self/fd`) must stay inside the root, and the path must still
 *      resolve to the same device+inode. Bytes are streamed FROM THE FD, so a
 *      post-check swap cannot change what is served (TOCTOU shrunk to the
 *      open).
 *   5. RANGES: single-range `bytes=` only; multi/!bytes forms serve the whole
 *      file; bounds are clamped; empty/negative/overflowing/backwards ranges
 *      are 416.
 *   6. PUBLIC SHELF IS OFF: a second (Caddy-served, unauthenticated) root is
 *      listed ONLY when explicitly enabled (`WEBUI_SHELF_PUBLIC_ENABLED=1`) and
 *      is never served by this proxy — only linked. Default: no public root is
 *      even stat'd.
 *
 * Node builtins only — this module is imported by `server/index.ts` and must
 * create no import cycle.
 */

import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Frozen interface
// ---------------------------------------------------------------------------

/** File URLs live here. Do not rename — chips/links are built against it. */
export const SHELF_FILE_PREFIX = "/api/shelf/file/";
/** The JSON listing endpoint. */
export const SHELF_LIST_PATH = "/api/shelf/list";

// ---------------------------------------------------------------------------
// Configuration. `WEBUI_SHELF_*` is the core name; `FILE_SHELF_*` keeps an
// existing file-shelf extension install working. Read lazily.
// ---------------------------------------------------------------------------

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** The shelf root: `~/hosted` unless overridden. A DEDICATED directory. */
export function shelfRoot(): string {
  return envFirst("WEBUI_SHELF_ROOT", "FILE_SHELF_ROOT") ?? join(homedir(), "hosted");
}

/** Public shelf is opt-in. Without this, no public root is touched at all. */
export function shelfPublicEnabled(): boolean {
  return envFirst("WEBUI_SHELF_PUBLIC_ENABLED") === "1";
}

/** Public shelf root (Caddy-served, NOT served by this proxy). */
export function shelfPublicRoot(): string {
  return envFirst("WEBUI_SHELF_PUBLIC_ROOT") ?? "/srv/hosted-public";
}

/** URL prefix the public shelf is mounted at (Caddy). */
export function shelfPublicPrefix(): string {
  return envFirst("WEBUI_SHELF_PUBLIC_PREFIX") ?? "/shared";
}

/** Hard cap on listing/search results. */
export function shelfMaxEntries(): number {
  const n = Number(envFirst("WEBUI_SHELF_MAX_ENTRIES"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4000;
}

// ---------------------------------------------------------------------------
// Types (mirrored by src/components/shelf/shelfApi.ts)
// ---------------------------------------------------------------------------

export type ShelfKind = "image" | "video" | "audio" | "pdf" | "text" | "other";

export interface ShelfEntry {
  name: string;
  path: string;
  /** "dir" for folders; a media kind for files. */
  kind: ShelfKind | "dir";
  size: number;
  mtime: number;
  mime: string | null;
  /** Directory listings only. */
  count?: number;
}

// ---------------------------------------------------------------------------
// Content types + hardening headers
// ---------------------------------------------------------------------------

/** Inline allowlist — inert media only. `.html`, `.svg`, `.xml`, `.js`, `.css`,
 *  `.wasm` and friends are deliberately ABSENT: they fall through to a forced
 *  download. */
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".weba": "audio/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};

const HARDEN: Record<string, string> = {
  // A stray .html/.svg is an opaque origin: no script, no cookies, no origin.
  "content-security-policy":
    "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  // Auth-gated private bytes: never let any cache keep them.
  "cache-control": "private, no-store",
};

function mimeOf(name: string): string | null {
  return MIME[extname(name).toLowerCase()] ?? null;
}

function kindOf(mime: string | null): ShelfKind {
  if (!mime) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || mime.startsWith("application/json")) return "text";
  return "other";
}

function deny(message: string, status: number): Response {
  return Response.json({ ok: false, error: message }, { status, headers: HARDEN });
}

// ---------------------------------------------------------------------------
// Root confinement
// ---------------------------------------------------------------------------

/**
 * The webui install root (the repo in dev, the package dir when installed).
 * The shelf root must never overlap it — source and dist are not shelf files.
 * Best-effort: null when it cannot be resolved (e.g. inside a compiled binary).
 */
const APP_ROOT: string | null = (() => {
  try {
    return realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  } catch {
    return null;
  }
})();

/**
 * A shelf root must be a DEDICATED directory. Refuse `/`, `$HOME`, the process
 * cwd, the webui install root, and anything that would make home/cwd/install a
 * descendant (i.e. an over-broad ancestor). Returns the realpath, or null.
 */
function realDedicatedRoot(root: string): string | null {
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    return null;
  }
  let st;
  try {
    st = statSync(base);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;

  const home = homedir();
  const cwd = process.cwd();
  const broad = (p: string) => p === sep || p === "/";
  if (broad(base) || base === home || base === cwd) return null;
  if (home.startsWith(base + sep) || cwd.startsWith(base + sep)) return null;
  // Never the repo/install dir — neither as the root nor as a descendant of it.
  if (APP_ROOT) {
    if (base === APP_ROOT || base.startsWith(APP_ROOT + sep) || APP_ROOT.startsWith(base + sep)) {
      return null;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * A shelf-relative path is safe when it is relative, non-empty, and every
 * segment is a plain name: no `.`/`..`, no leading dot (dotfiles are hidden),
 * no empty segment, no NUL, no backslash. Runs on the DECODED path, so
 * `%2e%2e` has already become `..` and is refused here.
 */
function isSafeRel(rel: string): boolean {
  if (rel === "" || rel.includes("\0") || rel.includes("\\")) return false;
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (segment.startsWith(".")) return false;
  }
  return true;
}

/** Percent-decode exactly once. Returns null on malformed escapes (e.g. `%`, overlong UTF-8). */
function decodeOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Real path of an OPEN fd (`/proc/self/fd`), else the path we opened. */
function realpathOfFd(fd: number, fallback: string): string | null {
  try {
    return realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    /* non-Linux — fall back to the resolved path */
  }
  try {
    return realpathSync(fallback);
  } catch {
    return null;
  }
}

function contained(base: string, target: string): boolean {
  return target === base || target.startsWith(base + sep);
}

// ---------------------------------------------------------------------------
// Verified open (TOCTOU-resistant)
// ---------------------------------------------------------------------------

interface OpenedFile {
  fd: number;
  size: number;
  name: string;
}

/**
 * Open `rel` inside `root` and verify it before any byte is read:
 *   - resolve against the DEDICATED root and require containment;
 *   - `O_NOFOLLOW` refuses a final-component symlink;
 *   - `fstat` must report a regular file (no dirs, fifos, devices, sockets);
 *   - the fd's real path must stay inside the root (catches intermediate
 *     symlink escape);
 *   - the path must still resolve to the same device+inode as the fd (catches
 *     a swap between resolution and open).
 * Returns null on any failure. The caller streams from `fd` and owns closing it.
 */
function openVerified(root: string, rel: string): OpenedFile | null {
  const base = realDedicatedRoot(root);
  if (!base) return null;
  const target = resolve(base, rel);
  if (!contained(base, target)) return null;

  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }

  let st;
  try {
    st = fstatSync(fd);
  } catch {
    closeSync(fd);
    return null;
  }
  if (!st.isFile()) {
    closeSync(fd);
    return null;
  }

  const real = realpathOfFd(fd, target);
  if (!real || !contained(base, real)) {
    closeSync(fd);
    return null;
  }

  try {
    const again = statSync(target);
    if (again.dev !== st.dev || again.ino !== st.ino) {
      closeSync(fd);
      return null;
    }
  } catch {
    closeSync(fd);
    return null;
  }

  return { fd, size: st.size, name: basename(real) };
}

// ---------------------------------------------------------------------------
// Listing (metadata only; confinement via realpath per entry)
// ---------------------------------------------------------------------------

interface WalkResult {
  items: ShelfEntry[];
  truncated: boolean;
}

function entryOf(base: string, abs: string, rel: string, name: string): ShelfEntry | null {
  // Resolve through the realpath and require containment BEFORE trusting it.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (!contained(base, real)) return null;
  let st;
  try {
    st = statSync(real);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    let count: number | undefined;
    try {
      count = readdirSync(real, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).length;
    } catch {
      count = undefined;
    }
    return { name, path: rel, kind: "dir", size: 0, mtime: st.mtimeMs, mime: null, count };
  }
  if (!st.isFile()) return null;
  const mime = mimeOf(name);
  return { name, path: rel, kind: kindOf(mime), size: st.size, mtime: st.mtimeMs, mime };
}

function listDir(base: string, dirReal: string, rel: string, cap: number): WalkResult {
  let entries;
  try {
    entries = readdirSync(dirReal, { withFileTypes: true });
  } catch {
    return { items: [], truncated: false };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const items: ShelfEntry[] = [];
  let truncated = false;
  for (const e of entries) {
    if (items.length >= cap) {
      truncated = true;
      break;
    }
    if (e.name.startsWith(".")) continue;
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    const entry = entryOf(base, join(dirReal, e.name), childRel, e.name);
    if (entry) items.push(entry);
  }
  items.sort((a, b) => {
    const ad = a.kind === "dir" ? 0 : 1;
    const bd = b.kind === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
  return { items, truncated };
}

function walkFiles(base: string, cap: number): WalkResult {
  const items: ShelfEntry[] = [];
  let truncated = false;
  const walk = (dirReal: string, rel: string, depth: number): void => {
    if (truncated || depth > 24) return;
    let entries;
    try {
      entries = readdirSync(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (items.length >= cap) {
        truncated = true;
        return;
      }
      if (e.name.startsWith(".")) continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      const entry = entryOf(base, join(dirReal, e.name), childRel, e.name);
      if (!entry) continue;
      if (entry.kind === "dir") walk(join(dirReal, e.name), childRel, depth + 1);
      else items.push(entry);
    }
  };
  walk(base, "", 0);
  return { items, truncated };
}

function filterItems(items: ShelfEntry[], q: string, cap: number): ShelfEntry[] {
  const needle = q.toLowerCase();
  const out: ShelfEntry[] = [];
  for (const item of items) {
    if (item.path.toLowerCase().includes(needle)) {
      out.push(item);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function publicPayload(): { publicRoot: string | null; publicPrefix: string | null; publicItems: ShelfEntry[] } {
  if (!shelfPublicEnabled()) return { publicRoot: null, publicPrefix: null, publicItems: [] };
  const publicRoot = shelfPublicRoot();
  const base = realDedicatedRoot(publicRoot);
  return {
    publicRoot,
    publicPrefix: shelfPublicPrefix(),
    // Metadata only; the public root is served by Caddy, never by this proxy.
    publicItems: base ? walkFiles(base, shelfMaxEntries()).items : [],
  };
}

function listResponse(url: URL): Response {
  const root = shelfRoot();
  const cap = shelfMaxEntries();
  const base = realDedicatedRoot(root);
  const flat = url.searchParams.get("flat") !== "0";
  const q = url.searchParams.get("q");

  const pub = publicPayload();

  if (!base) {
    // Root missing or refused: an empty, honest listing (not a 404) so the UI
    // can explain the configuration rather than look broken.
    return Response.json(
      {
        ok: true,
        root,
        dir: "",
        parent: null,
        search: q ?? null,
        count: 0,
        truncated: false,
        entries: [],
        items: [],
        exists: false,
        maxEntries: cap,
        ...pub,
      },
      { headers: HARDEN },
    );
  }

  if (q !== null) {
    const needle = q.trim();
    if (needle.length > 200 || needle.includes("\0")) return deny("bad query", 400);
    const { items, truncated } = walkFiles(base, cap);
    const matches = needle === "" ? items : filterItems(items, needle, cap);
    return Response.json(
      {
        ok: true,
        root,
        dir: "",
        parent: null,
        search: needle,
        count: matches.length,
        truncated: truncated || matches.length >= cap,
        entries: matches,
        items: flat ? matches : [],
        exists: true,
        maxEntries: cap,
        ...pub,
      },
      { headers: HARDEN },
    );
  }

  const rawDir = url.searchParams.get("dir") ?? "";
  const dir = rawDir.replace(/^\/+/, "").replace(/\/+$/, "");
  if (dir !== "" && !isSafeRel(dir)) return deny("not found", 404);

  let dirReal = base;
  if (dir !== "") {
    // Confine the directory too (open-less: metadata listing only).
    const candidate = resolve(base, dir);
    if (!contained(base, candidate)) return deny("not found", 404);
    try {
      dirReal = realpathSync(candidate);
    } catch {
      return deny("not found", 404);
    }
    if (!contained(base, dirReal)) return deny("not found", 404);
  }

  const listed = listDir(base, dirReal, dir, cap);
  const parent = dir === "" ? null : dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  const flatItems = flat ? walkFiles(base, cap) : { items: [], truncated: false };

  return Response.json(
    {
      ok: true,
      root,
      dir,
      parent,
      search: null,
      count: listed.items.length,
      truncated: listed.truncated || flatItems.truncated,
      entries: listed.items,
      items: flatItems.items,
      exists: true,
      maxEntries: cap,
      ...pub,
    },
    { headers: HARDEN },
  );
}

/**
 * Single-range `bytes=` parser. Returns null for absent/multi/!bytes forms
 * (serve the whole file), or `{ unsatisfiable }` for a 416. Bounds are clamped.
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | { unsatisfiable: true } | null {
  if (!header) return null;
  if (size <= 0) return { unsatisfiable: true };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  if (start > end || start >= size) return { unsatisfiable: true };
  if (end < 0) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(inline: boolean, name: string): string {
  const safe = name.replace(/["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(name);
  return `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

const CHUNK = 64 * 1024;

/** Stream `length` bytes from an already-verified fd, then close it. */
function fdStream(fd: number, start: number, length: number): ReadableStream<Uint8Array> {
  let pos = start;
  let remaining = length;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        close();
        controller.close();
        return;
      }
      const want = Math.min(CHUNK, remaining);
      const buf = Buffer.allocUnsafe(want);
      let n: number;
      try {
        n = readSync(fd, buf, 0, want, pos);
      } catch (err) {
        close();
        controller.error(err);
        return;
      }
      if (n <= 0) {
        close();
        controller.close();
        return;
      }
      pos += n;
      remaining -= n;
      controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, n));
    },
    cancel() {
      close();
    },
  });
}

function fileResponse(req: Request, url: URL): Response {
  const raw = url.pathname.slice(SHELF_FILE_PREFIX.length);
  const decoded = decodeOnce(raw);
  if (decoded === null) return deny("not found", 404);
  const rel = decoded.replace(/^\/+/, "");
  if (!isSafeRel(rel)) return deny("not found", 404);

  const opened = openVerified(shelfRoot(), rel);
  if (!opened) return deny("not found", 404);
  const { fd, size, name } = opened;

  const inlineMime = mimeOf(name);
  const forceDownload = url.searchParams.get("dl") === "1";
  const inline = inlineMime !== null && !forceDownload;

  // Inert inline media (raster image / video / audio / PDF — never .svg/.html/
  // .xml, which mimeOf() refuses) must be embeddable by the SAME-ORIGIN webui:
  // the chat preview frames and the shelf viewer are same-origin, and the
  // browser's PDF viewer refuses to initialize under the attachment-grade
  // `sandbox` + `frame-ancestors 'none'` CSP (blank viewer). Relax ONLY the
  // framing directive for these types; every other header is unchanged and
  // attachment/active types keep HARDEN untouched.
  const kind = kindOf(inlineMime);
  const inertMedia = inline && (kind === "pdf" || kind === "image" || kind === "video" || kind === "audio");
  const headers: Record<string, string> = {
    ...HARDEN,
    ...(inertMedia ? { "content-security-policy": "frame-ancestors 'self'" } : {}),
    "content-type": inline ? inlineMime : "application/octet-stream",
    "accept-ranges": "bytes",
    "content-disposition": contentDisposition(inline, name),
  };

  const isHead = req.method === "HEAD";
  const range = parseRange(req.headers.get("range"), size);
  if (range && "unsatisfiable" in range) {
    closeSync(fd);
    return new Response(null, {
      status: 416,
      headers: { ...HARDEN, "content-range": `bytes */${size}` },
    });
  }

  if (range) {
    const { start, end } = range;
    const length = end - start + 1;
    const ranged: Record<string, string> = {
      ...headers,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(length),
    };
    if (isHead) {
      closeSync(fd);
      return new Response(null, { status: 206, headers: ranged });
    }
    return new Response(fdStream(fd, start, length), { status: 206, headers: ranged });
  }

  if (isHead) {
    closeSync(fd);
    return new Response(null, { headers: { ...headers, "content-length": String(size) } });
  }
  return new Response(fdStream(fd, 0, size), {
    headers: { ...headers, "content-length": String(size) },
  });
}

// ---------------------------------------------------------------------------
// Entry point — called by server/index.ts AFTER the auth gate.
// ---------------------------------------------------------------------------

/**
 * Handle a `/api/shelf/*` request. Returns `null` when the path is not ours,
 * so the caller can fall through to the `/api` passthrough exactly as before.
 *
 * SECURITY: the caller MUST invoke this only AFTER the session-auth gate has
 * passed. The handler has no credential of its own and no bypass path.
 */
export function handleShelfRequest(req: Request, url: URL): Response | null {
  const path = url.pathname;
  const ours = path === SHELF_LIST_PATH || path.startsWith(SHELF_FILE_PREFIX);
  if (!ours) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return deny("method not allowed", 405);
  if (path === SHELF_LIST_PATH) return listResponse(url);
  return fileResponse(req, url);
}
