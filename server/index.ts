#!/usr/bin/env bun
/**
 * opencode-webui proxy server.
 *
 * The browser never talks to the opencode service directly. This Bun server
 * discovers the background service (Service.ensure), attaches the auth
 * headers, and proxies /api/* with streaming. In production it also serves
 * the built frontend from dist/.
 *
 * Dev flow:  vite (5173) --/api--> this server (4097) --> opencode service
 * Prod flow: this server (4097) serves dist/ + proxies /api
 *
 * Access control (server/auth.ts): every route except the login round-trip
 * requires a session cookie. WEBUI_PASSWORD sets the password; unset means a
 * strong passphrase is generated and printed once — but only on a loopback
 * bind, because a wildcard bind without a password refuses to start. The
 * browser never holds service credentials, and neither the password nor
 * session tokens are ever logged.
 */

import { Service } from "@opencode-ai/client/service";
import type { Server } from "bun";
import { existsSync, mkdirSync, readFileSync, statSync, watch, appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SANDBOX,
  guardRequest,
  handleLogin,
  isAuthed,
  isLoopbackHostname,
  loadSecret,
  loginPageResponse,
  logoutResponse,
  peerIP,
  resolveAuthPolicy,
  unauthorizedResponse,
} from "./auth";
import { syncSkill } from "./skillSync";
import {
  discoverUserUIEntries,
  extensionSourceRoots,
  globalUserExtensionsDir,
  invalidateExtensionCache,
  warnOnce,
  type UIEntry,
} from "./userExtensions";
import {
  applyExtResponseMiddleware,
  dispatchExtEvent,
  dispatchExtRequest,
  runExtRequestMiddleware,
  startExtModules,
} from "./ext/registry";
import { resolveEngineOverride } from "./ext/engine";

// `sandbox` argv — one command, every runtime: `bun run sandbox` (repo, the
// script adds Vite), `bunx opencode-webui sandbox`, `./opencode-webui sandbox`
// (compiled binary). Defaults live HERE so all three behave identically:
// loopback bind, passwordless (WEBUI_SANDBOX), port 4099, and an ISOLATED
// extension dir (scratch) — WIP extensions stay invisible to the main
// instance until copied out. Explicit env wins over every default.
if (process.argv.includes("sandbox")) {
  process.env.WEBUI_SANDBOX ??= "1";
  process.env.WEBUI_PROXY_PORT ??= "4099";
  if (!process.env.WEBUI_EXTENSION_DIR) {
    const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    process.env.WEBUI_EXTENSION_DIR = join(state, "opencode-webui", "sandbox-extensions");
    mkdirSync(process.env.WEBUI_EXTENSION_DIR, { recursive: true, mode: 0o700 });
  }
}

const PROXY_PORT = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
// Client headers never forwarded to the engine: transport (recomputed by Bun
// from the proxied request), identity (must WIN over anything the client
// sends), and credentials the browser has no business relaying.
const FORBIDDEN_CLIENT_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "accept-encoding",
  "authorization",
  "cookie",
  "content-length",
  "expect",
  "proxy-authorization",
]);
const HOST = process.env.WEBUI_HOST ?? "127.0.0.1";
// Bun binds 0.0.0.0 by default; keep the safe loopback default and only pass
// through what the operator actually asked for ("localhost" binds 127.0.0.1).
const BIND_HOST = HOST === "localhost" ? "127.0.0.1" : HOST;
// fileURLToPath, not .pathname — .pathname yields "/C:/..." on Windows and
// breaks every join; inside a --compile binary this stays a virtual /$bunfs
// path that scripts/embed-shim.ts maps onto the embedded assets.
const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEBUG_LOG = process.env.WEBUI_DEBUG_LOG ?? "/tmp/webui-debug.log";
const DEBUG = Bun.env.WEBUI_DEBUG === "1";
const REPORT_REPO = process.env.WEBUI_REPORT_REPO ?? "AbdelftahZowail/opencode-webui";

function dbg(...args: unknown[]) {
  if (!DEBUG) return;
  console.log("[webui]", ...args);
}

async function writeDebug(lines: unknown[]) {
  const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  try {
    await appendFile(DEBUG_LOG, text + "\n", "utf8");
  } catch (err) {
    console.error("[webui] debug log write failed:", err);
  }
}

let endpoint: Awaited<ReturnType<typeof Service.ensure>> | null = null;

async function serviceEndpoint() {
  // Explicit env wins: WEBUI_ENGINE_URL aims the proxy at a chosen engine.
  // An override URL also SKIPS Service.ensure() — no spawn from a stale
  // service.json pid (the rogue-serve incident), no version-kill of the
  // chosen engine. Same resolution as ctx.engine (see server/ext/engine.ts).
  const override = resolveEngineOverride();
  if (override) {
    if (!endpoint || endpoint.url !== override.url) {
      endpoint = override;
      console.log(`[webui] connected to opencode service at ${override.url} (WEBUI_ENGINE_URL)`);
    }
    return endpoint;
  }
  if (!endpoint) {
    endpoint = await Service.ensure();
    console.log(`[webui] connected to opencode service at ${endpoint.url}`);
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// Proxy crash-reason persistence (G-T8).
//
// One sandbox death left no cause. Fatal reasons are appended to CRASH_LOG
// (never thrown from there — the crash path must not crash) and the last
// entry is surfaced on the next boot, so an agent can see why the proxy died
// without having watched it die. Semantics are unchanged: uncaught exceptions
// still exit(1) (the Node default), rejections keep the runtime's behavior —
// only observability is added.
// ---------------------------------------------------------------------------

const CRASH_LOG =
  process.env.WEBUI_CRASH_LOG ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-webui", "proxy-crash.log");

function persistCrashReason(kind: "uncaughtException" | "unhandledRejection", reason: unknown): void {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  try {
    mkdirSync(dirname(CRASH_LOG), { recursive: true, mode: 0o700 });
    appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${kind}: ${detail}\n`, "utf8");
  } catch {
    /* crash path — never throw */
  }
  console.error(`[webui] ${kind} (recorded in ${CRASH_LOG}):`, detail.split("\n")[0]);
}

process.on("uncaughtException", (err) => {
  persistCrashReason("uncaughtException", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  persistCrashReason("unhandledRejection", reason);
});

// ---------------------------------------------------------------------------
// Live-event recorder (catch-up for late-joining browsers).
//
// The engine serves NO mid-stream text over REST (verified: part skeletons
// appear with text:0 until each part ends) and a FRESH /api/event
// subscription receives only future events — so a browser that attaches,
// reloads or reconnects mid-run loses everything since the run started (the
// "stream starts 5-15s late" bug). The TUI never detaches; the browser does.
//
// This proxy is the always-on background: it holds ONE service-side event
// subscription of its own and keeps a bounded per-session ring buffer of
// recent session-scoped events. Browsers fetch
//   GET /api/webui/replay?sessionID=X[&since=<eventID>]
// on session join and on (re)connect and feed the events through the exact
// same reducer path — id-based dedupe (seenEventIDs) and overlap-safe delta
// appends (appendStreamDelta) make replaying already-seen events harmless.
// ---------------------------------------------------------------------------

const RECORDER_MAX_EVENTS = 400; // per session
const RECORDER_MAX_BYTES = 512 * 1024; // per session
const RECORDER_SESSION_TTL_MS = 10 * 60_000; // idle sessions drop after this
const RECORDER_MAX_SESSIONS = 60;
const RECORDER_SEEN_MAX = 20_000; // engine-replay dedupe window

// `bytes` is the event's JSON size, computed ONCE at record time — the ring
// caps used to re-stringify on every push AND every drop. (Served replay
// payloads carry the extra field; the client picks only known fields.)
type RecordedEvent = { id: string; created: number; type: string; data: unknown; bytes: number };
const replayBuffers = new Map<string, { events: RecordedEvent[]; bytes: number; lastAt: number }>();
const recorderSeenIds = new Set<string>();

function recordEvent(evt: RecordedEvent) {
  const sessionID = (evt.data as { sessionID?: string } | undefined)?.sessionID;
  if (!sessionID) return;
  // Engine replays overlap on reconnect — dedupe by event id (bounded).
  if (evt.id) {
    if (recorderSeenIds.has(evt.id)) return;
    recorderSeenIds.add(evt.id);
    if (recorderSeenIds.size > RECORDER_SEEN_MAX) recorderSeenIds.clear();
  }
  // Proxy-stratum event tap (spec §8): headless extensions observe the same
  // deduped stream the replay buffer keeps. Fire-and-forget, never blocks.
  void dispatchExtEvent(evt).catch((err) => console.error("[webui] ext onEvent failed:", err));
  let buf = replayBuffers.get(sessionID);
  if (!buf) {
    // Hard cap on tracked sessions; drop the least recently active.
    if (replayBuffers.size >= RECORDER_MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of replayBuffers) {
        if (v.lastAt < oldestAt) {
          oldestAt = v.lastAt;
          oldestKey = k;
        }
      }
      if (oldestKey) replayBuffers.delete(oldestKey);
    }
    buf = { events: [], bytes: 0, lastAt: Date.now() };
    replayBuffers.set(sessionID, buf);
  }
  const entry: RecordedEvent = { ...evt, bytes: JSON.stringify(evt).length };
  buf.events.push(entry);
  buf.bytes += entry.bytes;
  buf.lastAt = Date.now();
  // Ring caps: newest wins.
  while (buf.events.length > RECORDER_MAX_EVENTS || buf.bytes > RECORDER_MAX_BYTES) {
    const dropped = buf.events.shift();
    if (!dropped) break;
    buf.bytes -= dropped.bytes;
  }
  // TTL prune (cheap: on insert, only when the map is large).
  if (replayBuffers.size > 8) {
    const now = Date.now();
    for (const [k, v] of replayBuffers) {
      if (now - v.lastAt > RECORDER_SESSION_TTL_MS) replayBuffers.delete(k);
    }
  }
}

let recorderRunning = false;
async function startEventRecorder() {
  if (recorderRunning) return;
  recorderRunning = true;
  void (async () => {
    for (;;) {
      try {
        const ep = await serviceEndpoint();
        const res = await fetch(`${ep.url}/api/event`, { headers: Service.headers(ep) });
        if (!res.ok || !res.body) throw new Error(`recorder: ${res.status}`);
        console.log("[webui] event recorder connected");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            try {
              const parsed = JSON.parse(trimmed.slice("data:".length).trim()) as RecordedEvent;
              if (typeof parsed.type === "string" && parsed.type.startsWith("session.")) {
                recordEvent(parsed);
              }
            } catch {
              /* malformed line — skip */
            }
          }
        }
      } catch (err) {
        console.warn("[webui] event recorder dropped, reconnecting:", err instanceof Error ? err.message : err);
        // The service may have restarted with a NEW url — re-discover.
        endpoint = null;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
}

// ---------------------------------------------------------------------------
// Plugin web-UI extensions.
//
// opencode v2 plugins may ship an optional BROWSER half next to their server
// code. The engine lists loaded plugins at GET /plugin ({ location,
// data: PluginInfo[] }). For every LOCAL-source plugin we probe two UI entry
// candidates next to it — `<dir>/ui/main.tsx`, then
// `<dir>/<base>.ui.tsx` — bundle the first that exists with Bun.build into an
// ESM script and serve:
//
//   GET /api/webui/extensions                -> { data: [{ id, url?, domUrl?, source }] }
//   GET /api/webui/extensions/:id/bundle.js  -> text/javascript, no-cache (browser stratum)
//   GET /api/webui/extensions/:id/dom.js     -> text/javascript, no-cache (DOM stratum, spec §7)
//
// `react` (+ `react/jsx-runtime`, `react/jsx-dev-runtime`) are EXTERNAL in
// every bundle — never inlined. The page's index.html carries an import map
// pointing those bare specifiers at /api/webui/vendor/*.js, which re-export
// the app's own React via the window.__opencodeUI bridge (installed at boot,
// re-ensured by the runtime loader before every import). One React instance
// for app and extensions alike: inlining a second copy breaks hooks
// (invalid-hook-call on the first useState). The vendor shims are the only
// copy extensions ever see.
//
// Both routes ride the same session auth as every other /api call (the
// upstream plugin list is fetched with Service.headers) and register BEFORE
// the generic /api passthrough below. `source` in the listing is the bundled
// UI entry path; `url`'s ?v= is that file's mtime so edits bust caches.
// v1 limitation: package/builtin/sdk sources have nothing on disk to bundle
// and are ignored.
//
// USER extension dirs (server/userExtensions.ts) merge into the same
// manifest below — same pipeline, `source: "user:<path>"`.
// ---------------------------------------------------------------------------

type PluginSource =
  | { type: "local"; path: string }
  | { type: "package"; package?: string }
  | { type: "builtin" }
  | { type: "sdk" };

type PluginInfo = {
  id?: string; // absent on status:"failed" entries
  source: PluginSource;
  status: "active" | "failed";
  error?: string;
};

const EXTENSION_LIST_TTL_MS = 5_000;
let uiEntryCache: { at: number; entries: UIEntry[] } | null = null;

// entry path -> bundle, rebuilt only when the entry's mtime moves
const bundleCache = new Map<string, { mtimeMs: number; js: string }>();

function uiEntryCandidates(pluginPath: string): string[] {
  const dir = dirname(pluginPath);
  const base = basename(pluginPath).replace(/\.[^.]+$/, "");
  return [join(dir, "ui", "main.tsx"), join(dir, `${base}.ui.tsx`)];
}

/** Active local plugins' UI entries. Cached 5s; any upstream failure -> []. */
async function discoverUIEntries(): Promise<UIEntry[]> {
  const now = Date.now();
  if (uiEntryCache && now - uiEntryCache.at < EXTENSION_LIST_TTL_MS) {
    return uiEntryCache.entries;
  }
  const entries: UIEntry[] = [];
  try {
    const ep = await serviceEndpoint();
    const upstream = await fetch(`${ep.url}/api/plugin`, { headers: Service.headers(ep) });
    if (!upstream.ok) throw new Error(`GET ${ep.url}/api/plugin -> ${upstream.status}`);
    const body = (await upstream.json()) as { data?: PluginInfo[] };
    for (const plugin of body.data ?? []) {
      // v1: disk sources only. Failed engine-halves still get their UI half
      // served: a plugin can fail to LOAD server-side (missing deps, bad
      // schema) while its UI is perfectly fine — failed entries carry no id,
      // so one is derived from the file basename.
      if (plugin.source.type !== "local") continue;
      const srcPath = plugin.source.path;
      try {
        const fallbackId = basename(srcPath).replace(/\.[^.]+$/, "");
        const entry = uiEntryCandidates(srcPath).find((c) => existsSync(c));
        if (!entry) continue;
        entries.push({
          id: plugin.id ?? fallbackId,
          entry,
          mtimeMs: statSync(entry).mtimeMs,
        });
      } catch (err) {
        console.error(`[webui] plugin "${plugin.id ?? srcPath}" skipped during ui discovery:`, err);
      }
    }
  } catch (err) {
    // Never throw to callers — an unreachable engine just means no extensions.
    console.error("[webui] plugin ui discovery failed:", err instanceof Error ? err.message : err);
  }
  uiEntryCache = { at: now, entries };
  return entries;
}

/**
 * Folder extensions (user > project > shipped, same-id swap) PLUS engine
 * plugin UI halves. Folder ids win collisions: a folder may shadow a
 * plugin's UI — presence on disk is the deliberate override.
 */
async function discoverAllUIEntries(): Promise<UIEntry[]> {
  const pluginEntries = await discoverUIEntries();
  const folderEntries = discoverUserUIEntries();
  if (folderEntries.length === 0) return pluginEntries;
  const ids = new Set(folderEntries.map((e) => e.id));
  const merged = [...folderEntries];
  for (const plugin of pluginEntries) {
    if (ids.has(plugin.id)) {
      warnOnce(`collide:${plugin.id}`, `plugin extension "${plugin.id}" skipped — a folder already owns that id`);
      continue;
    }
    merged.push(plugin);
  }
  return merged;
}

/** Bundled JS for a UI entry, cached by mtime so an edit costs one rebuild. */
async function bundleUIEntry(entry: string): Promise<string> {
  const mtimeMs = statSync(entry).mtimeMs;
  const cached = bundleCache.get(entry);
  if (cached && cached.mtimeMs === mtimeMs) return cached.js;
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    // React is EXTERNAL — never inlined. Extension bundles import the bare
    // specifiers and the page's import map (index.html) resolves them to
    // /api/webui/vendor/*.js, which re-export the app's own React instance.
    // Resolving react to a FILE path here (the old react-from-app plugin)
    // inlined a private second copy -> invalid-hook-call on first useState.
    external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
  });
  const artifact =
    built.outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".js")) ??
    built.outputs.find((o) => o.path.endsWith(".js"));
  for (const log of built.logs) {
    // Build warnings/errors are the ONLY server-side signal for a broken
    // extension — a failing bundle must never be silent (the page just sees
    // a missing entry). Bun.build failures throw below; warnings print here.
    console.warn(`[webui] extension bundle build (${entry}): ${log.message}`);
  }
  if (!artifact) throw new Error(`bun.build produced no js artifact for ${entry}`);
  const js = await artifact.text();
  bundleCache.set(entry, { mtimeMs, js });
  return js;
}

// ---------------------------------------------------------------------------
// Shared-React vendor shims (import-map targets for external bundles).
//
// Extension bundles import the bare specifiers "react",
// "react/jsx-runtime" and "react/jsx-dev-runtime" (see `external` above).
// The page's import map (index.html) resolves those to these routes, which
// re-export the APP's React instance via the window.__opencodeUI bridge —
// installed at boot (main.tsx) and re-ensured by the runtime loader before
// every bundle import, so the bridge always exists when a shim executes.
// No React code ships in these shims and none is inlined into bundles:
// there is exactly one React instance in the page.
//
// The named-export list is derived from the running app's react copy so it
// stays correct across React upgrades without hand-maintained lists.
// ---------------------------------------------------------------------------

const REACT_NAMED_EXPORTS: string[] = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ns = require("react") as Record<string, unknown>;
    return Object.keys(ns).filter(
      (k) => k !== "default" && k !== "__esModule" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k),
    );
  } catch {
    // Fallback: hooks + primitives an extension could plausibly import.
    return [
      "Children", "Component", "Fragment", "Profiler", "PureComponent", "StrictMode", "Suspense",
      "cache", "cloneElement", "createContext", "createElement", "createRef", "forwardRef",
      "isValidElement", "lazy", "memo", "startTransition", "use", "useCallback", "useContext",
      "useDebugValue", "useDeferredValue", "useEffect", "useId", "useImperativeHandle",
      "useInsertionEffect", "useLayoutEffect", "useMemo", "useReducer", "useRef", "useState",
      "useSyncExternalStore", "useTransition", "version",
    ];
  }
})();

const REACT_VENDOR_JS = `// Shared-React shim: re-exports the app's React (window.__opencodeUI.react).
// Served by the proxy at /api/webui/vendor/react.js (import-map target).
const R = globalThis.__opencodeUI?.react;
if (!R) throw new Error("[webui] React bridge not ready: window.__opencodeUI.react is missing");
export default R;
export const { ${REACT_NAMED_EXPORTS.join(", ")} } = R;
`;

// The automatic JSX transform calls jsx()/jsxs() to build elements. These
// delegate to createElement on the SAME shared instance, so elements and
// hooks always agree on the dispatcher. __source/__self (dev) are stripped.
const JSX_RUNTIME_BODY = `const R = globalThis.__opencodeUI?.react;
if (!R) throw new Error("[webui] React bridge not ready: window.__opencodeUI.react is missing");
export const Fragment = R.Fragment;
function _el(type, props, key) {
  const p = { ...(props || {}) };
  const children = p.children;
  delete p.children;
  delete p.__source;
  delete p.__self;
  if (key !== undefined) p.key = key;
  if (children === undefined) return R.createElement(type, p);
  return Array.isArray(children) ? R.createElement(type, p, ...children) : R.createElement(type, p, children);
}
export function jsx(type, props, key) { return _el(type, props, key); }
export function jsxs(type, props, key) { return _el(type, props, key); }
`;

const REACT_JSX_RUNTIME_VENDOR_JS = `// Shared-React shim for react/jsx-runtime (import-map target).
${JSX_RUNTIME_BODY}`;

const REACT_JSX_DEV_RUNTIME_VENDOR_JS = `// Shared-React shim for react/jsx-dev-runtime (import-map target).
${JSX_RUNTIME_BODY}export function jsxDEV(type, props, key) { return _el(type, props, key); }
`;

function vendorShimFor(path: string): string | null {
  if (path === "/api/webui/vendor/react.js") return REACT_VENDOR_JS;
  if (path === "/api/webui/vendor/react-jsx-runtime.js") return REACT_JSX_RUNTIME_VENDOR_JS;
  if (path === "/api/webui/vendor/react-jsx-dev-runtime.js") return REACT_JSX_DEV_RUNTIME_VENDOR_JS;
  return null;
}

// ---------------------------------------------------------------------------
// Extension manifest push (spec §6: replaces the 8s browser poll).
//
// The proxy watches all three folder sources, rebuilds changed bundles
// (bundleCache is mtime-keyed, so the next bundle.js fetch rebuilds), bumps
// the manifest version, and pushes it over SSE; the page re-imports bundles
// whose ?v= moved and same-id-swaps them in the registry — sub-second, no
// refresh. Delete/move = uninstall (the id vanishes from the manifest and
// the page unregisters it); manifest `disabled: true` = paused.
// ---------------------------------------------------------------------------

type ManifestItem =
  | { id: string; source: string; origin?: UIEntry["origin"]; url?: string; domUrl?: string }
  | { id: string; source: string; origin?: UIEntry["origin"]; disabled: true };

async function buildExtensionManifest(): Promise<ManifestItem[]> {
  // discoverAllUIEntries never throws; upstream failures collapse to [].
  const entries = await discoverAllUIEntries();
  return entries.map((e) => {
    if (e.disabled || (!e.entry && !e.domEntry)) {
      return { id: e.id, source: e.source ?? e.entry, origin: e.origin, disabled: true as const };
    }
    const item: { id: string; source: string; origin?: UIEntry["origin"]; url?: string; domUrl?: string } = {
      id: e.id,
      source: e.source ?? e.entry,
      origin: e.origin,
    };
    // Shipped browser stratum loads via the in-repo Vite glob
    // (webui-extensions/index.ts, Vite HMR) — never via a bundle URL, or
    // module side effects run twice and `extension.loaded` fires twice
    // (Bug 2). Omit `url` for shipped origin; a user/project copy shadowing
    // the same id wins discovery with origin user/project, keeps its `url`,
    // and same-id-swaps over the glob copy. DOM stratum (`domUrl`) still
    // serves for shipped: the glob never loads `dom.ts`, so there is no
    // double-load there and omitting it would break shipped DOM extensions.
    if (e.entry && e.origin !== "shipped") {
      item.url = `/api/webui/extensions/${encodeURIComponent(e.id)}/bundle.js?v=${e.mtimeMs}`;
    }
    // DOM stratum (spec §7): its own `?v=` — a `dom.ts` edit changes the
    // manifest JSON, which is what fires the SSE push (no second channel).
    if (e.domEntry && e.domMtimeMs !== undefined) {
      item.domUrl = `/api/webui/extensions/${encodeURIComponent(e.id)}/dom.js?v=${e.domMtimeMs}`;
    }
    return item;
  });
}

let extManifestVersion = 0;
let lastManifestJSON = "";
const extManifestListeners = new Set<(msg: string) => void>();

function broadcastExtensionManifest() {
  const msg = JSON.stringify({ type: "webui.extensions", version: extManifestVersion });
  for (const send of extManifestListeners) send(msg);
}

/**
 * Re-scan and push when the manifest actually changed (edits change ?v=
 * mtimes, adds/removes/disabled-flips change the id set). Returns true on
 * change. Watcher-triggered scans invalidate the TTL caches first so the
 * push is immediate, not up-to-5s late.
 */
async function checkExtensionManifest(immediate: boolean): Promise<boolean> {
  if (immediate) {
    invalidateExtensionCache();
    uiEntryCache = null;
  }
  const manifest = await buildExtensionManifest();
  const json = JSON.stringify(manifest);
  if (json === lastManifestJSON) return false;
  lastManifestJSON = json;
  extManifestVersion++;
  dbg("extensions manifest v" + extManifestVersion + ":", manifest.length, "entr(ies)");
  broadcastExtensionManifest();
  return true;
}

const watchedExtRoots = new Set<string>();
let extRescanTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleExtRescan() {
  if (extRescanTimer) return;
  extRescanTimer = setTimeout(() => {
    extRescanTimer = null;
    void checkExtensionManifest(true);
  }, 300); // coalesce save-bursts (edit + manifest.json write land together)
}

function ensureExtWatchers() {
  const attach = (path: string) => {
    if (watchedExtRoots.has(path)) return;
    try {
      const watcher = watch(path, { persistent: false }, () => scheduleExtRescan());
      watcher.on("error", () => {
        // Path deleted (or never existed) — drop it; a later rescan
        // re-attaches when it reappears.
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
        watchedExtRoots.delete(path);
      });
      watchedExtRoots.add(path);
    } catch {
      /* absent path — retry on the next rescan */
    }
  };
  for (const root of extensionSourceRoots()) attach(root);
  // Each extension folder too: a content-only edit (index.tsx bytes,
  // manifest.json `disabled` flip) fires no event on the PARENT root watch
  // (inotify reports only direct-child create/delete/rename there) — without
  // this, edits would wait for the 5s backstop instead of pushing sub-second.
  // discoverUserUIEntries() is TTL-cached, so this sweep is cheap.
  const PREFIX = "webui-extensions:";
  for (const e of discoverUserUIEntries()) {
    const dir = e.entry
      ? dirname(e.entry)
      : e.source?.startsWith(PREFIX)
        ? e.source.slice(PREFIX.length)
        : null;
    if (dir) attach(dir);
  }
}

let extWatcherRunning = false;
/** fs.watch for immediacy + a 5s re-scan for engine-plugin drift and roots. */
function startExtensionWatcher() {
  if (extWatcherRunning) return;
  extWatcherRunning = true;
  ensureExtWatchers();
  void checkExtensionManifest(true); // seed lastManifestJSON + version 1
  setInterval(() => {
    ensureExtWatchers(); // attach to roots that appeared since boot
    void checkExtensionManifest(false);
  }, 5_000).unref?.();
}

// ---------------------------------------------------------------------------
// Boot: CLI flag → auth policy → skill sync → serve → banner.
// ---------------------------------------------------------------------------

/** `--install-skill`: copy the skill and exit without starting the server. */
if (process.argv.includes("--install-skill")) {
  const result = await syncSkill();
  if (result.ok) console.log(`[webui] skill installed at ${result.target}`);
  else console.error(`[webui] skill install failed: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}

// Exits with a clear message when a wildcard bind has no WEBUI_PASSWORD.
const AUTH = resolveAuthPolicy(HOST);
const SECRET = loadSecret();
const SKILL = await syncSkill(); // best-effort — never blocks the banner below it

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PKG_VERSION = readVersion();

const server: Server<Record<string, unknown>> = Bun.serve({
  port: PROXY_PORT,
  hostname: BIND_HOST,
  // Bun's default idleTimeout (10s) kills any socket silent for 10s. The
  // engine heartbeats /api/event every 15s, so an idle session's connection
  // is guaranteed to die before the next heartbeat — that WAS the "SSE
  // wedge" (instrumented 2026-08-31: bun c#N killed exactly 10s after the
  // last byte, vite never told, browser fuse fired at 20s). It also broke
  // the session.wait long-polls (silent for minutes). Liveness here is
  // owned by engine heartbeats + browser fuse + req.signal aborts — not a
  // socket timer — so disable it.
  idleTimeout: 0,
  async fetch(req, bunServer) {
    // A malformed Host that passes the loopback guard can still make
    // `new URL(req.url)` throw (e.g. `localhost:99999`); an unhandled throw
    // here renders Bun's error page WITH the server source — never leak it.
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const method = req.method;
    const path = url.pathname;

    // DNS-rebinding + cross-origin guard — before ANY route, login included.
    const guarded = guardRequest(req, HOST);
    if (guarded) return guarded;

    // The unauthenticated surface: login page, login POST, logout.
    if (method === "GET" && path === "/login") return loginPageResponse(url);
    if (method === "POST" && path === "/api/auth/login") {
      return handleLogin(req, peerIP(req, bunServer), SECRET, AUTH.digest);
    }
    if (method === "GET" && path === "/api/auth/logout") return logoutResponse();

    // Everything below — /api/* (JSON 401), pages, dist/ static, SSE, and
    // WebSocket upgrades — requires a valid session cookie. A SANDBOX
    // instance (loopback-only, passwordless) skips the gate entirely.
    if (!SANDBOX() && !isAuthed(req, SECRET)) return unauthorizedResponse(url);

    if (method === "GET" && path === "/api/webui/status") {
      try {
        const ep = await serviceEndpoint();
        return Response.json({ ok: true, service: ep.url });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 503 },
        );
      }
    }

    // Proxy metadata: app version + where to report issues.
    if (method === "GET" && path === "/api/webui/config") {
      return Response.json({ version: PKG_VERSION, reportRepo: REPORT_REPO });
    }

    if (method === "POST" && path === "/api/debug") {
      // Frontend log sink — append to the debug file, never forwarded.
      try {
        const body = (await req.json()) as unknown;
        const lines = Array.isArray(body) ? body : [body];
        void writeDebug(lines);
        dbg("debug log:", lines.length, "line(s) ->", DEBUG_LOG);
        return new Response("ok");
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 400 });
      }
    }

    // Live-event replay — proxy-local (the engine has no such route), serves
    // the recorder's ring buffer so a late-joining browser can catch up.
    if (method === "GET" && path === "/api/webui/replay") {
      const sessionID = url.searchParams.get("sessionID");
      if (!sessionID) return Response.json({ error: "sessionID required" }, { status: 400 });
      const since = url.searchParams.get("since") ?? "";
      const buf = replayBuffers.get(sessionID);
      let events = buf?.events ?? [];
      if (since) {
        const idx = events.findIndex((e) => e.id === since);
        if (idx >= 0) events = events.slice(idx + 1);
      }
      dbg("replay:", sessionID, `${events.length} event(s)`);
      return Response.json({ data: events });
    }

    // Extension manifest — folder entries (user > project > shipped) plus
    // plugin UI halves. Disabled entries ship WITHOUT a url so the page can
    // show them paused without importing anything. Shipped-origin browser
    // entries likewise ship without `url` (Bug 2: the in-repo Vite glob owns
    // them — a bundle URL here would double-load); shadowing user/project
    // copies keep their `url` and same-id-swap. `origin` lets the page tell
    // them apart; shipped `domUrl` still serves (the glob never loads dom).
    if (method === "GET" && path === "/api/webui/extensions") {
      const data = await buildExtensionManifest();
      dbg("extensions list:", data.length, "ui entr(ies)");
      return Response.json({ data, version: extManifestVersion });
    }

    // Manifest push channel (spec §6): one event per manifest change plus a
    // hello on subscribe. The page re-fetches the manifest on each event and
    // re-imports only bundles whose ?v= moved. Heartbeat comments keep the
    // stream alive through idle infrastructure.
    if (method === "GET" && path === "/api/webui/extensions/events") {
      const encoder = new TextEncoder();
      let send: ((msg: string) => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream({
        start(controller) {
          send = (msg: string) => {
            try {
              controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
            } catch {
              /* client gone — cancel() cleans up */
            }
          };
          extManifestListeners.add(send);
          send(JSON.stringify({ type: "webui.extensions", version: extManifestVersion }));
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {
              /* client gone */
            }
          }, 15_000);
        },
        cancel() {
          if (heartbeat) clearInterval(heartbeat);
          if (send) extManifestListeners.delete(send);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // Browser-stratum bundle (`bundle.js`) and DOM-stratum bundle
    // (`dom.js`, spec §7) — same mtime-keyed Bun.build pipeline, same
    // no-cache serving. Disabled entries 404 — the page must never import a
    // paused extension.
    if (method === "GET" && /^\/api\/webui\/extensions\/[^/]+\/(bundle|dom)\.js$/.test(path)) {
      const segs = path.split("/");
      const id = decodeURIComponent(segs[4] ?? "");
      const wantDom = (segs[5] ?? "").startsWith("dom");
      try {
        // Resolve through the CURRENT discovery result so removed/expired
        // plugins 404 instead of serving a stale bundle. Disabled entries
        // 404 too — the page must never import a paused extension.
        const found = (await discoverAllUIEntries()).find((e) => e.id === id);
        const entry = wantDom ? found?.domEntry : found?.entry;
        if (!found || found.disabled || !entry || !existsSync(entry)) {
          return Response.json({ error: `unknown extension: ${id}` }, { status: 404 });
        }
        const js = await bundleUIEntry(entry); // throws -> 500 below
        dbg("extensions bundle:", id, wantDom ? "(dom)" : "", `${js.length}b`);
        return new Response(js, {
          headers: { "content-type": "text/javascript", "cache-control": "no-cache" },
        });
      } catch (err) {
        console.error(`[webui] extension bundle "${id}" failed:`, err);
        return Response.json({ error: `bundle failed for ${id}` }, { status: 500 });
      }
    }

    if (path.startsWith("/api/webui/ext/")) {
      const extRes = await dispatchExtRequest(req, url);
      if (extRes) return extRes;
      return Response.json({ error: "unknown extension route" }, { status: 404 });
    }

    // Shared-React vendor shims (import-map targets — see bundleUIEntry).
    // Same session auth as every other /api route (gate above applies);
    // same-origin dynamic imports carry the session cookie. Content is
    // derived from the running app's react copy, so no-cache (tiny files).
    if (method === "GET" && path.startsWith("/api/webui/vendor/")) {
      const js = vendorShimFor(path);
      if (js === null) return Response.json({ error: "unknown vendor module" }, { status: 404 });
      return new Response(js, {
        headers: { "content-type": "text/javascript", "cache-control": "no-cache" },
      });
    }

    if (path.startsWith("/api")) {
      const isUpgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
      if (isUpgrade) {
        try {
          const ep = await serviceEndpoint();
          const headers = Service.headers(ep);
          const upgraded = server.upgrade(req, {
            data: { url: `${ep.url}${path}${url.search}`, headers },
          });
          dbg("ws upgrade:", path);
          if (upgraded) return undefined;
        } catch (err) {
          console.error("[webui] ws upgrade error:", err);
          return Response.json({ error: String(err) }, { status: 502 });
        }
      }
      const t0 = Date.now();
      try {
        // Proxy-stratum request middleware (spec §8): a returned Response
        // short-circuits the passthrough; a returned Request replaces it.
        let activeReq = req;
        const extRewrite = await runExtRequestMiddleware(req);
        if (extRewrite instanceof Response) return extRewrite;
        if (extRewrite instanceof Request) activeReq = extRewrite;
        const upMethod = activeReq.method;
        const ep = await serviceEndpoint();
        const headers = Service.headers(ep);
        const upstream: Response = await fetch(`${ep.url}${path}${url.search}`, {
          method: upMethod,
          // Abort the upstream request when the browser client goes away,
          // otherwise streamed responses (SSE) leak one connection per
          // client reconnect until the pool wedges and requests hang.
          signal: activeReq.signal,
          headers: {
            ...headers,
            // Forward only benign client headers. Service.headers must WIN —
            // spreading client headers over them let a client override the
            // engine credential (e.g. its own `authorization`). Also drop
            // spoofable/transport headers the engine should never see.
            ...Object.fromEntries(
              [...activeReq.headers.entries()].filter(([k]) => {
                const name = k.toLowerCase();
                if (FORBIDDEN_CLIENT_HEADERS.has(name)) return false;
                return (
                  !name.startsWith("x-forwarded-") && !name.startsWith("x-opencode-")
                );
              }),
            ),
            // Force identity from the engine: it brotli/gzip-compresses at
            // least the experimental session-log endpoint with a stream the
            // browser fails to decode (BrotliDecompressionError), and
            // compressed SSE would buffer idle heartbeats anyway. Loopback
            // hops gain nothing from compression — never request it.
            "accept-encoding": "identity",
          },
          body: ["GET", "HEAD"].includes(upMethod) ? undefined : activeReq.body,
          redirect: "manual",
        });

        const responseHeaders = new Headers(upstream.headers);
        const contentType = upstream.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          responseHeaders.delete("content-encoding");
        }
        dbg("proxy:", method, path, "->", upstream.status, `${Date.now() - t0}ms`);
        // Proxy-stratum response middleware (spec §8): uniform rewriting.
        return await applyExtResponseMiddleware(
          new Response(upstream.body, {
            status: upstream.status,
            headers: responseHeaders,
          }),
          req,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[webui] proxy error:", message);
        return Response.json({ error: message }, { status: 502 });
      }
    }

    // Serve the built frontend when it exists (npm package + compiled binary).
    // Production binaries force NODE_ENV=production via embed-shim; npm users
    // get dist/ in the tarball but run with NODE_ENV unset — detect an
    // installed package (no src/ on disk) vs a dev checkout (vite owns the
    // frontend). Dev with a stale dist/ still goes to vite for HMR.
    const hasDist = existsSync(join(DIST_DIR, "index.html"));
    const isDevCheckout = existsSync(join(APP_ROOT, "vite.config.ts"));
    if (Bun.env.NODE_ENV === "production" || (hasDist && !isDevCheckout)) {
      if (method === "GET" || method === "HEAD") {
        // decodeURIComponent throws on malformed escapes (e.g. "/%") — 400,
        // never an unhandled throw.
        let filePath: string;
        try {
          filePath = decodeURIComponent(path);
        } catch {
          return new Response("bad request", { status: 400 });
        }
        if (filePath === "/") filePath = "/index.html";
        // Confine to dist/: a decoded "/..%2f" must not escape the static
        // root (arbitrary file read = secret.key = cookie forgery).
        const resolved = resolve(DIST_DIR, "." + filePath);
        if (!resolved.startsWith(resolve(DIST_DIR))) {
          return new Response("not found", { status: 404 });
        }
        const file = Bun.file(resolved);
        if (await file.exists()) {
          // Hashed assets are immutable; anything NOT hash-named (index.html,
          // SPA fallbacks, favicon) must be revalidated — a cached index.html
          // pins the browser to a stale bundle after every update.
          const immutable = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(filePath);
          return new Response(file, {
            headers: {
              "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
            },
          });
        }
        const index = Bun.file(DIST_DIR + "index.html");
        if (await index.exists())
          return new Response(index, { headers: { "cache-control": "no-store" } });
      }
      return new Response("not found", { status: 404 });
    }

    return new Response("webui dev server: use vite (port 5173)", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
  websocket: {
    open(ws) {
      const data = ws.data as unknown as { url: string; headers: Record<string, string>; upstream?: WebSocket; pending?: unknown[] };
      try {
        const upstream = new WebSocket(data.url, { headers: data.headers } as unknown as string[]);
        data.upstream = upstream;
        data.pending = [];
        upstream.onopen = () => {
          const pending = data.pending ?? [];
          data.pending = [];
          for (const msg of pending) upstream.send(msg as Parameters<WebSocket["send"]>[0]);
        };
        upstream.onmessage = (e) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(e.data as string | ArrayBuffer);
        };
        upstream.onclose = () => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
        };
        upstream.onerror = () => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
        };
      } catch (err) {
        console.error("[webui] ws upstream error:", err);
        ws.close();
      }
    },
    message(ws, msg) {
      const data = ws.data as unknown as { upstream?: WebSocket; pending?: unknown[] };
      const upstream = data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(msg);
      else if (upstream && upstream.readyState === WebSocket.CONNECTING) data.pending!.push(msg);
    },
    close(ws) {
      const data = ws.data as unknown as { upstream?: WebSocket };
      data.upstream?.close();
    },
  },
});

// First-boot banner — the entire onboarding. The generated password is
// printed exactly once and never logged anywhere else.
const displayHost = isLoopbackHostname(HOST === "localhost" ? "localhost" : HOST) ? "localhost" : HOST;
console.log(
  [
    `[webui] ready → http://${displayHost}:${server.port}`,
    SANDBOX()
      ? `[webui] sandbox — loopback only, NO password; extensions (scratch): ${globalUserExtensionsDir()}`
      : `[webui] password: ${AUTH.generated ?? "from WEBUI_PASSWORD"}`,
    `[webui] same sessions as your opencode TUI — it's the same engine`,
    `[webui] extensions: drop folders in ${globalUserExtensionsDir()}/<name>/ (index.tsx + manifest.json)`,
    SKILL.ok
      ? `[webui] agent skill installed at ${SKILL.target} (auto-synced each boot)`
      : `[webui] agent skill NOT synced: ${SKILL.reason}`,
  ].join("\n"),
);
void startEventRecorder();
startExtensionWatcher();
void startExtModules();

// Crash-log boot note: if a previous proxy died fatally, its reason is the
// last line of CRASH_LOG — surface it so the next boot (or an agent reading
// the log) sees why without having watched it die.
try {
  if (existsSync(CRASH_LOG)) {
    const lines = readFileSync(CRASH_LOG, "utf8").trim().split("\n").filter((l) => l.length > 0);
    // Entries are multi-line (stacks) — the "last" entry is the last line
    // starting a new timestamped record, not the log's physical last line.
    const heads = lines.filter((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(l));
    const last = heads[heads.length - 1] ?? lines[lines.length - 1];
    if (last) console.log(`[webui] previous proxy crash (${heads.length} entr(ies) in ${CRASH_LOG}) — last: ${last.slice(0, 300)}`);
  }
} catch {
  /* observability only — never block boot */
}
