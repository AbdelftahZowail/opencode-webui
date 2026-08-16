/**
 * Preview orchestration: a SECOND dev instance on dedicated ports, so
 * work-in-progress UI edits can be reviewed on a fresh page while the
 * main dev app (5173/4097) and production (4097) stay untouched.
 *
 *   UI:      http://localhost:5174
 *   Proxy:   :4098  (auto-discovers the same opencode service)
 */

import { spawn } from "bun";

const env = {
  ...process.env,
  WEBUI_PROXY_PORT: "4098",
  WEBUI_VITE_PORT: "5174",
};

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

console.log("\n[preview] WIP UI at http://localhost:5174 (proxy :4098)\n");

async function shutdown() {
  proxy.kill();
  vite.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const done = await Promise.allSettled([proxy.exited, vite.exited]);
for (const result of done) {
  if (result.status === "rejected") console.error("[preview]", result.reason);
}
process.exit(1);
