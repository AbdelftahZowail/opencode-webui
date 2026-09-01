/**
 * Sandbox orchestration — the ONE second-instance mechanism, everywhere:
 *
 *   repo (dev)       bun run sandbox   → Vite + proxy, HMR intact
 *   bunx package     bunx opencode-webui sandbox → built bundle
 *   compiled binary  ./opencode-webui-<target> sandbox → built bundle
 *
 * All three converge on the SAME server-side defaults (see the `sandbox`
 * argv block in server/index.ts): loopback bind, passwordless (the bind
 * address is the guarantee), port 4099, isolated scratch extension dir.
 * This script only adds the Vite dev server when the repo is present.
 */

import { existsSync } from "node:fs";
import { spawn } from "bun";

const DEV = existsSync("src/App.tsx") && existsSync("node_modules/vite");

const env = {
  ...process.env,
  WEBUI_PROXY_PORT: process.env.WEBUI_PROXY_PORT ?? "4099",
  WEBUI_VITE_PORT: process.env.WEBUI_VITE_PORT ?? "5175",
  WEBUI_SANDBOX: "1",
};

const proxy = spawn({
  cmd: DEV
    ? ["bun", "run", "--watch", "server/index.ts", "sandbox"]
    : ["bun", "run", "server/index.ts", "sandbox"],
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

const vite = DEV
  ? spawn({ cmd: ["bunx", "vite"], env, stdio: ["inherit", "inherit", "inherit"] })
  : null;

console.log(
  DEV
    ? `\n[sandbox] dev UI at http://localhost:${env.WEBUI_VITE_PORT} (proxy :${env.WEBUI_PROXY_PORT}) — loopback only, no password; extensions: scratch dir\n`
    : `\n[sandbox] UI at http://localhost:${env.WEBUI_PROXY_PORT} — loopback only, no password; extensions: scratch dir\n`,
);

async function shutdown() {
  proxy.kill();
  vite?.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const done = await Promise.allSettled([proxy.exited, ...(vite ? [vite.exited] : [])]);
for (const result of done) {
  if (result.status === "rejected") console.error("[sandbox]", result.reason);
}
process.exit(1);
