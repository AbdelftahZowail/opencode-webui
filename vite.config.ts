import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

/**
 * Dev has TWO ports: Vite serves the UI here (VITE_PORT) and proxies /api to
 * the Bun proxy (SERVE.port). The bind address and allowed-host list come from
 * the SAME file/env the proxy reads, so opening the dev UI to a phone or
 * Tailscale is a Settings › Access change — not an env hunt. Override the Vite
 * port itself with WEBUI_VITE_PORT.
 *
 * Read inline (no `import "../server/config"`) on purpose: Vite's native config
 * loader cannot follow extensionless TS imports, so importing it would warn on
 * every dev boot (and break once native becomes the default). Keep these three
 * keys in sync with server/config.ts — env > file > default.
 */
function readServeSettings(): { host: string; port: number; allowedHosts: string[] } {
  let file: Record<string, unknown> = {};
  try {
    const base = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "webui");
    const parsed: unknown = JSON.parse(readFileSync(join(base, "config.json"), "utf8"));
    if (parsed && typeof parsed === "object") file = parsed as Record<string, unknown>;
  } catch {
    /* no file yet — defaults below */
  }
  const env = process.env;
  const host = env.WEBUI_HOST || (typeof file.host === "string" && file.host ? file.host : "127.0.0.1");
  const envPort = env.WEBUI_PROXY_PORT ? Number(env.WEBUI_PROXY_PORT) : NaN;
  const filePort = typeof file.port === "number" ? file.port : NaN;
  const port =
    Number.isInteger(envPort) && envPort > 0 && envPort < 65536
      ? envPort
      : Number.isInteger(filePort) && filePort > 0 && filePort < 65536
        ? filePort
        : 4097;
  const allowedHosts =
    env.WEBUI_ALLOWED_HOSTS !== undefined
      ? env.WEBUI_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(file.allowedHosts)
        ? file.allowedHosts.filter((v): v is string => typeof v === "string")
        : [];
  // Sandbox is loopback-only by contract (the proxy refuses any other bind) —
  // never let a network bind in the shared config leak the sandbox dev UI.
  if (env.WEBUI_SANDBOX === "1") return { host: "127.0.0.1", port, allowedHosts: [] };
  return { host, port, allowedHosts };
}

const SERVE = readServeSettings();
const VITE_PORT = Number(process.env.WEBUI_VITE_PORT ?? 5173);

/** Config `host` → Vite `server.host` (wildcard means every interface). */
function viteHost(host: string): string | boolean | undefined {
  if (host === "0.0.0.0" || host === "::" || host === "*") return true;
  if (host === "127.0.0.1" || host === "localhost") return undefined; // Vite default
  return host;
}

/** Config `allowedHosts` → Vite `server.allowedHosts` ("*" disables the check). */
function viteAllowedHosts(hosts: string[]): string[] | true | undefined {
  if (hosts.includes("*")) return true;
  return hosts.length > 0 ? hosts : undefined;
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
    // Phone/Tailscale dev: Vite binds loopback and 403s unknown Host headers
    // on its own, independent of the proxy's guard. Mirror the config so the
    // same Settings › Access values reach the dev UI server too.
    host: viteHost(SERVE.host),
    allowedHosts: viteAllowedHosts(SERVE.allowedHosts),
    watch: {
      // Root-level non-module artifacts (AGENTS.md, docs/**, .codegraph/**)
      // get scanned by @tailwindcss/vite; before upstream #20414 its
      // hot-update fallback turns any change to them into a FULL page
      // reload. They are never part of the module graph — don't watch them.
      ignored: ["**/*.md", "**/*.log", "**/docs/**", "**/.codegraph/**"],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${SERVE.port}`,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
