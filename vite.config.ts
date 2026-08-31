import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

const PROXY_PORT = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
const VITE_PORT = Number(process.env.WEBUI_VITE_PORT ?? 5173);

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
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
