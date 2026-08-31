import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

const PROXY_PORT = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
const VITE_PORT = Number(process.env.WEBUI_VITE_PORT ?? 5173);

/**
 * TEMPORARY SSE wedge instrumentation ([ssehop] lines in the debug timeline).
 * The browser fuse fires after 20s of zero bytes while the chain looks
 * healthy — these counters attach to every proxied text/event-stream response
 * and measure BOTH sides of vite's pipe: bytes read from the proxy upstream
 * and bytes handed to the browser socket. Paired with the proxy-side counters
 * (instrumentSseUpstream in server/index.ts), a wedge resolves to the exact
 * hop that swallowed the bytes. Remove once the culprit is found.
 */
let viteSseSeq = 0;
function ssehop(msg: string) {
  const d = new Date();
  const t = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  void fetch(`http://127.0.0.1:${PROXY_PORT}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([`[${t}] [ssehop] ${msg}`]),
  }).catch(() => {}); // proxy restarting/offline — diagnostics, never retry-loop
}
function instrumentViteSse(
  proxyRes: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) {
  const contentType = String(proxyRes.headers["content-type"] ?? "");
  if (!contentType.includes("text/event-stream")) return;
  const conn = ++viteSseSeq;
  const openedAt = Date.now();
  let upstreamBytes = 0;
  let browserBytes = 0;
  let lastByteAt = openedAt;
  let warnedSilent = false;
  const say = (msg: string) => ssehop(`vite c#${conn} ${msg}`);
  say("open");
  proxyRes.on("data", (chunk: Buffer) => {
    upstreamBytes += chunk.length;
    lastByteAt = Date.now();
  });
  // http-proxy pipes proxyRes -> res via res.write; wrapping it here (before
  // the pipe starts) counts what actually reaches the browser socket.
  const rawWrite = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (chunk != null) {
      browserBytes +=
        typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk as Buffer).length;
      lastByteAt = Date.now();
    }
    return rawWrite(chunk, ...rest);
  }) as typeof res.write;
  const silencer = setInterval(() => {
    const age = Date.now() - lastByteAt;
    if (age < 17_000 || warnedSilent) return; // healthy never crosses it (15s heartbeats)
    warnedSilent = true;
    say(`silent ${Math.round(age / 1000)}s: ${upstreamBytes}B in, ${browserBytes}B out`);
  }, 1000);
  res.on("close", () => {
    clearInterval(silencer);
    say(
      `close after ${((Date.now() - openedAt) / 1000).toFixed(1)}s: ` +
        `${upstreamBytes}B in, ${browserBytes}B out`,
    );
  });
}

/**
 * Coalesce full-page-reload pushes. Agents (and humans) save in bursts;
 * a naive dev server reloads the browser on EVERY save of a boundary-less
 * module (src/store.ts) or newly added file, wiping UI state mid-read.
 * Full reloads are held until the file system goes quiet for SETTLE_MS,
 * flushed early once MAX_WAIT_MS elapses so the page is never stale for
 * long. Regular HMR updates are NOT delayed — only destructive reloads.
 */
function coalesceFullReload(): Plugin {
  const SETTLE_MS = 1_000;
  const MAX_WAIT_MS = 10_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;

  return {
    name: "webui:coalesce-full-reload",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      const raw = server.ws.send.bind(server.ws) as (payload: unknown) => void;
      server.ws.send = ((payload: unknown) => {
        const type = (payload as { type?: string } | null)?.type;
        if (type !== "full-reload") return raw(payload);
        const now = Date.now();
        if (!firstAt) firstAt = now;
        if (timer) clearTimeout(timer);
        const wait = Math.min(SETTLE_MS, Math.max(0, MAX_WAIT_MS - (now - firstAt)));
        timer = setTimeout(() => {
          timer = null;
          firstAt = 0;
          raw({ type: "full-reload" });
        }, wait);
      }) as typeof server.ws.send;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), coalesceFullReload()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: VITE_PORT,
    watch: {
      // Root-level non-module artifacts (AGENTS.md, docs/**, .codegraph/**)
      // get scanned by @tailwindcss/vite; before upstream #20414 its
      // hot-update fallback turns any change to them into a FULL page
      // reload. They are never part of the module graph — don't watch them.
      ignored: ["**/*.md", "**/*.log", "**/docs/**", "**/.codegraph/**"],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${PROXY_PORT}`,
        changeOrigin: false,
        ws: true,
        configure(proxy) {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            instrumentViteSse(
              proxyRes as import("node:http").IncomingMessage,
              res as import("node:http").ServerResponse,
            );
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
