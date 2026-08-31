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
 */

import { Service } from "@opencode-ai/client/service";
import type { Server } from "bun";
import { existsSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const PROXY_PORT = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
const DIST_DIR = new URL("../dist/", import.meta.url).pathname;
const APP_ROOT = new URL("../", import.meta.url).pathname;
const DEBUG_LOG = process.env.WEBUI_DEBUG_LOG ?? "/tmp/webui-debug.log";
const DEBUG = Bun.env.WEBUI_DEBUG === "1";

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
  if (!endpoint) {
    endpoint = await Service.ensure();
    console.log(`[webui] connected to opencode service at ${endpoint.url}`);
  }
  return endpoint;
}

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
// `<dir>/<base>.ui.tsx` — bundle the first that exists with Bun.build into a
// self-contained ESM script (it carries its own React and talks to this app
// only through the window.__opencodeUI bridge), and serve:
//
//   GET /api/webui/extensions                -> { data: [{ id, url, source }] }
//   GET /api/webui/extensions/:id/bundle.js  -> text/javascript, no-cache
//
// Both routes ride the same service auth as every other /api call (the
// upstream plugin list is fetched with Service.headers) and register BEFORE
// the generic /api passthrough below. `source` in the listing is the bundled
// UI entry path; `url`'s ?v= is that file's mtime so edits bust caches.
// v1 limitation: package/builtin/sdk sources have nothing on disk to bundle
// and are ignored.
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

type UIEntry = { id: string; entry: string; mtimeMs: number };

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
    // Plugin dirs have no node_modules — resolve React from THIS app so every
    // runtime bundle shares one React copy. JSX dev/runtime variants included.
    plugins: [
      {
        name: "react-from-app",
        setup(build) {
          build.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime)?$/ }, (args) => ({
            path: join(
              APP_ROOT,
              "node_modules",
              "react",
              args.path === "react" ? "index.js" : `${args.path.slice("react/".length)}.js`,
            ),
          }));
        },
      },
    ],
  });
  const artifact =
    built.outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".js")) ??
    built.outputs.find((o) => o.path.endsWith(".js"));
  if (!artifact) throw new Error(`bun.build produced no js artifact for ${entry}`);
  const js = await artifact.text();
  bundleCache.set(entry, { mtimeMs, js });
  return js;
}

const server: Server<Record<string, unknown>> = Bun.serve({
  port: PROXY_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

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

    // Plugin web-UI extensions — must match before the generic /api proxy.
    if (method === "GET" && path === "/api/webui/extensions") {
      // discoverUIEntries never throws; failures collapse to { data: [] }.
      const entries = await discoverUIEntries();
      dbg("extensions list:", entries.length, "ui entr(ies)");
      return Response.json({
        data: entries.map((e) => ({
          id: e.id,
          source: e.entry,
          url: `/api/webui/extensions/${encodeURIComponent(e.id)}/bundle.js?v=${e.mtimeMs}`,
        })),
      });
    }

    if (method === "GET" && /^\/api\/webui\/extensions\/[^/]+\/bundle\.js$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      try {
        // Resolve through the CURRENT discovery result so removed/expired
        // plugins 404 instead of serving a stale bundle.
        const found = (await discoverUIEntries()).find((e) => e.id === id);
        if (!found || !existsSync(found.entry)) {
          return Response.json({ error: `unknown extension: ${id}` }, { status: 404 });
        }
        const js = await bundleUIEntry(found.entry); // throws -> 500 below
        dbg("extensions bundle:", id, `${js.length}b`);
        return new Response(js, {
          headers: { "content-type": "text/javascript", "cache-control": "no-cache" },
        });
      } catch (err) {
        console.error(`[webui] extension bundle "${id}" failed:`, err);
        return Response.json({ error: `bundle failed for ${id}` }, { status: 500 });
      }
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
        const ep = await serviceEndpoint();
        const headers = Service.headers(ep);
        const upstream: Response = await fetch(`${ep.url}${path}${url.search}`, {
          method,
          // Abort the upstream request when the browser client goes away,
          // otherwise streamed responses (SSE) leak one connection per
          // client reconnect until the pool wedges and requests hang.
          signal: req.signal,
          headers: {
            ...headers,
            ...Object.fromEntries(
              [...req.headers.entries()].filter(
                ([k]) =>
                  !["host", "connection", "upgrade", "accept-encoding"].includes(
                    k.toLowerCase(),
                  ),
              ),
            ),
            // Force identity from the engine: it brotli/gzip-compresses at
            // least the experimental session-log endpoint with a stream the
            // browser fails to decode (BrotliDecompressionError), and
            // compressed SSE would buffer idle heartbeats anyway. Loopback
            // hops gain nothing from compression — never request it.
            "accept-encoding": "identity",
          },
          body: ["GET", "HEAD"].includes(method) ? undefined : req.body,
          redirect: "manual",
        });

        const responseHeaders = new Headers(upstream.headers);
        const contentType = upstream.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          responseHeaders.delete("content-encoding");
        }
        dbg("proxy:", method, path, "->", upstream.status, `${Date.now() - t0}ms`);
        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[webui] proxy error:", message);
        return Response.json({ error: message }, { status: 502 });
      }
    }

    if (Bun.env.NODE_ENV === "production") {
      if (method === "GET" || method === "HEAD") {
        let filePath = decodeURIComponent(path);
        if (filePath === "/") filePath = "/index.html";
        const file = Bun.file(DIST_DIR + filePath.slice(1));
        if (await file.exists()) return new Response(file);
        const index = Bun.file(DIST_DIR + "index.html");
        if (await index.exists()) return new Response(index);
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

console.log(`[webui] proxy listening on http://127.0.0.1:${server.port}`);
void startEventRecorder();
