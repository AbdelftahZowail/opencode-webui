#!/usr/bin/env bun
/**
 * Lifecycle-plugin engine check — the one thing unit tests cannot prove:
 * an ISOLATED OpenCode engine auto-discovers the plugin we install into
 * `<config>/opencode/plugins/opencode-webui/`, loads it (state active), and its
 * `setup()` spawns the launch command from `launch.json`.
 *
 *   bun run check:setup:engine
 *
 * SKIPs (exit 0) when no v2 engine binary is available (`opencode2` on PATH or
 * `OPENCODE_ENGINE_BIN`). Uses its own XDG dirs + cwd; never touches the
 * developer's engine, config, plugin dir, or sessions.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIFECYCLE_PLUGIN_PACKAGE_JSON,
  LIFECYCLE_PLUGIN_SOURCE,
} from "../../server/lifecyclePlugin";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function engineBin(): string | null {
  const override = process.env.OPENCODE_ENGINE_BIN;
  if (override && override.length > 0) return override;
  const found = Bun.spawnSync(["which", "opencode2"]);
  const path = found.exitCode === 0 ? found.stdout.toString().trim().split("\n")[0]?.trim() : "";
  return path && path.length > 0 ? path : null;
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port ?? 0;
  server.stop(true);
  if (port <= 0) throw new Error("could not allocate a free port");
  return port;
}

function authHeaders(service: { password?: string }): Record<string, string> {
  if (!service.password) return {};
  return { authorization: "Basic " + Buffer.from(`opencode:${service.password}`).toString("base64") };
}

const bin = engineBin();
if (!bin) {
  console.log("SKIP lifecycle-plugin engine check — no `opencode2` (set OPENCODE_ENGINE_BIN to run)");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "webui-setup-engine-"));
const configHome = join(root, "config");
const stateHome = join(root, "state");
const dataHome = join(root, "data");
const cwd = join(root, "cwd");
const pluginDir = join(configHome, "opencode", "plugins", "opencode-webui");
for (const dir of [pluginDir, join(stateHome, "opencode"), dataHome, cwd]) mkdirSync(dir, { recursive: true });

// Only auto-discovery may load the plugin: no `plugins`/`plugin` config entry.
writeFileSync(
  join(configHome, "opencode", "opencode.jsonc"),
  JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
);
writeFileSync(join(pluginDir, "index.js"), LIFECYCLE_PLUGIN_SOURCE);
writeFileSync(join(pluginDir, "package.json"), LIFECYCLE_PLUGIN_PACKAGE_JSON);
// The real install also drops this marker; prove it does not disturb discovery.
writeFileSync(join(pluginDir, ".opencode-webui.json"), JSON.stringify({ managed: true, version: "0.0.0" }));

const marker = join(root, "spawned.txt");
mkdirSync(join(stateHome, "opencode-webui"), { recursive: true });
writeFileSync(
  join(stateHome, "opencode-webui", "launch.json"),
  JSON.stringify({
    cmd: ["/bin/sh", "-c", `printf spawn-ok > '${marker}'`],
    display: "test",
    port: 0,
    version: "0.0.0",
    updatedAt: Date.now(),
  }),
);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const port = freePort();
const proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--service"], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, XDG_DATA_HOME: dataHome },
});
let log = "";
const pump = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) log += new TextDecoder().decode(value);
    }
  } catch {
    /* torn down with the child */
  }
};
void pump(proc.stdout);
void pump(proc.stderr);

try {
  // The engine activates a location's plugins lazily — the first `/api/plugin`
  // read is what loads them. So poll that (as a client would on use), which is
  // also exactly when the webui is expected to start.
  let service: { url: string; password?: string } | null = null;
  const serviceDeadline = Date.now() + 30_000;
  while (Date.now() < serviceDeadline && service === null) {
    try {
      service = JSON.parse(readFileSync(join(stateHome, "opencode", "service.json"), "utf8")) as {
        url: string;
        password?: string;
      };
    } catch {
      await sleep(300);
    }
  }
  check("engine: isolated service registered", service !== null);

  let ids: string[] = [];
  let state = "";
  const pluginDeadline = Date.now() + 60_000;
  while (service && Date.now() < pluginDeadline) {
    try {
      const res = await fetch(`${service.url}/api/plugin`, { headers: authHeaders(service), signal: AbortSignal.timeout(4_000) });
      const body = (await res.json()) as { data?: Array<{ id?: string; state?: { status?: string } }> };
      const hit = (body.data ?? []).find((e) => e.id === "opencode-webui");
      ids = (body.data ?? []).map((e) => e.id ?? "?");
      if (hit) {
        state = hit.state?.status ?? "";
        if (state === "active") break;
      }
    } catch {
      /* retry */
    }
    await sleep(1_000);
  }
  check("engine: auto-discovered plugin reports active", state === "active", `state=${state || "absent"} ids=${ids.join(",") || "none"}`);

  const markerDeadline = Date.now() + 8_000;
  while (Date.now() < markerDeadline && !existsSync(marker)) await sleep(200);
  check("engine: activated plugin's setup() spawned the launch command", existsSync(marker), marker);
} finally {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  await sleep(600);
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nengine log tail:\n${log.slice(-1_200)}`);
}
console.log(`\nRESULT: ${passed} pass · ${failed} fail → exit ${failed > 0 ? 1 : 0}`);
process.exit(failed > 0 ? 1 : 0);
