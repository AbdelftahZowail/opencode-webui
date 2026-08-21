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
import { appendFile } from "node:fs/promises";

const PROXY_PORT = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
const DIST_DIR = new URL("../dist/", import.meta.url).pathname;
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
          headers: {
            ...headers,
            ...Object.fromEntries(
              [...req.headers.entries()].filter(
                ([k]) => !["host", "connection", "upgrade"].includes(k.toLowerCase()),
              ),
            ),
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
