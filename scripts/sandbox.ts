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
 *
 * Stacking: one method, no flags. When the default ports are free this
 * behaves exactly as documented (:4099/:5175 + shared scratch dir). When
 * another sandbox already holds them, this instance auto-isolates — free
 * ports + a fresh mkdtemp extension dir — and prints what it picked.
 * Explicit env (WEBUI_PROXY_PORT / WEBUI_VITE_PORT / WEBUI_EXTENSION_DIR)
 * always wins and disables that knob's auto behavior. The engine stays
 * shared (same sessions everywhere, by design).
 */

import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const DEV = existsSync("src/App.tsx") && existsSync("node_modules/vite");

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("sandbox: could not allocate a free port");
  return port;
}

function freshScratchDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-sandbox-"), { encoding: "utf8" });
}

const DEFAULT_PROXY_PORT = "4099";
const DEFAULT_VITE_PORT = "5175";

let proxyPort = process.env.WEBUI_PROXY_PORT ?? DEFAULT_PROXY_PORT;
let vitePort = process.env.WEBUI_VITE_PORT ?? DEFAULT_VITE_PORT;
let extDir = process.env.WEBUI_EXTENSION_DIR;
let isolated = false;

// Auto-isolate only for knobs the operator didn't pin: a busy default port
// means another sandbox is already up, so take free ports + a fresh dir.
if (
  process.env.WEBUI_PROXY_PORT === undefined ||
  process.env.WEBUI_VITE_PORT === undefined ||
  extDir === undefined
) {
  const proxyBusy =
    process.env.WEBUI_PROXY_PORT === undefined &&
    !(await portFree(Number(DEFAULT_PROXY_PORT)));
  const viteBusy =
    DEV &&
    process.env.WEBUI_VITE_PORT === undefined &&
    !(await portFree(Number(DEFAULT_VITE_PORT)));
  if (proxyBusy || viteBusy) {
    if (process.env.WEBUI_PROXY_PORT === undefined) proxyPort = String(await freePort());
    if (DEV && process.env.WEBUI_VITE_PORT === undefined) vitePort = String(await freePort());
    if (extDir === undefined) extDir = freshScratchDir();
    isolated = true;
  }
}

const env = {
  ...process.env,
  WEBUI_PROXY_PORT: proxyPort,
  WEBUI_VITE_PORT: vitePort,
  ...(extDir !== undefined ? { WEBUI_EXTENSION_DIR: extDir } : {}),
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
    ? `\n[sandbox] dev UI at http://localhost:${vitePort} (proxy :${proxyPort}) — loopback only, no password; extensions: ${isolated ? `ISOLATED scratch dir ${extDir}` : "scratch dir"}\n`
    : `\n[sandbox] UI at http://localhost:${proxyPort} — loopback only, no password; extensions: ${isolated ? `ISOLATED scratch dir ${extDir}` : "scratch dir"}\n`,
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
