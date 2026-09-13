/**
 * Dev orchestration: starts the proxy server and the Vite dev server
 * together, forwards stdio, and tears both down on exit.
 *
 * The dev proxy listens on its OWN default port (4098), not the configured
 * serve `port` (default 4097). That port is owned by the production server,
 * the lifecycle plugin, and Settings — so `bun run dev` must never squat it:
 * dev and prod can run side by side, and Tailscale can point at either
 * (Vite :5173 for dev, :4097 for prod) without a collision. Vite follows via
 * the same WEBUI_PROXY_PORT env it already reads, so /api proxies to 4098.
 * An explicit WEBUI_PROXY_PORT always wins.
 */

import { spawn } from "bun";

const DEV_PROXY_PORT = process.env.WEBUI_PROXY_PORT ?? "4098";
const VITE_PORT = process.env.WEBUI_VITE_PORT ?? "5173";
const env = { ...process.env, WEBUI_PROXY_PORT: DEV_PROXY_PORT };

const proxy = spawn({
  cmd: ["bun", "run", "--watch", "server/index.ts"],
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

const vite = spawn({
  cmd: ["bunx", "vite"],
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

console.log(
  `\n[dev] UI at http://localhost:${VITE_PORT} (dev proxy :${DEV_PROXY_PORT}) — prod stays on the configured port (:4097 by default)\n`,
);

async function shutdown() {
  proxy.kill();
  vite.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const done = await Promise.allSettled([proxy.exited, vite.exited]);
for (const result of done) {
  if (result.status === "rejected") console.error("[dev]", result.reason);
}
process.exit(1);
