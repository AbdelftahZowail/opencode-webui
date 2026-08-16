/**
 * Dev orchestration: starts the proxy server and the Vite dev server
 * together, forwards stdio, and tears both down on exit.
 */

import { spawn } from "bun";

const proxy = spawn({
  cmd: ["bun", "run", "--watch", "server/index.ts"],
  stdio: ["inherit", "inherit", "inherit"],
});

const vite = spawn({
  cmd: ["bunx", "vite"],
  stdio: ["inherit", "inherit", "inherit"],
});

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
