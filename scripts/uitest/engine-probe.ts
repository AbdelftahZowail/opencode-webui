#!/usr/bin/env bun
/**
 * Engine-seam probe battery (IN-5 — generalizes the brother-agent probe pattern).
 *
 *   bun scripts/uitest/engine-probe.ts
 *
 * Loads scripts/uitest/engine-fixture/ against a PROBE engine and asserts:
 *
 *   E1  probe serve boots on an isolated port with own XDG dirs + own cwd
 *       (never touches the developer's engine, config, or sessions)
 *   E2  GET /api/plugin lists `webui-engine-fixture` with state active
 *       (polled — the route populates lazily after boot)
 *   E3  the registered tool executes: execute({text}) resolves
 *       `{ output: "pong: …" }` (the {output} contract, no bare string)
 *   E4  the system hint pushes `{ type: "text", text }` (the drain-safe shape)
 *
 * E3/E4 run in-process against the same fixture files via a stub api object
 * (the engine exposes no headless tool-execute route, and model execution
 * needs provider credentials — the probe proves the engine ACCEPTS the
 * payload, the stub proves the payload BEHAVES). Ports/scratch are isolated
 * and cleaned unconditionally.
 *
 * Test-only file: asserts on engine behaviour, modifies nothing in the repo.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE_DIR = join(import.meta.dir, "engine-fixture");
const FIXTURE_ID = "webui-engine-fixture";
const SCRATCH = `/tmp/opencode/eng-probe-${process.pid}`;
const PLUGIN_TIMEOUT_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Row {
  label: string;
  status: "PASS" | "FAIL";
  detail: string;
  secs?: number;
}
const rows: Row[] = [];

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port;
  s.stop(true);
  if (typeof port !== "number" || port <= 0) throw new Error("could not obtain a free port");
  return port;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let engineProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let engineLog = "";

async function cleanup(): Promise<void> {
  if (engineProc) {
    const pid = engineProc.pid;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && pidAlive(pid)) await sleep(200);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    engineProc = null;
  }
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

interface ServiceInfo {
  url: string;
  password?: string;
}

/**
 * The v2 engine binary (the `opencode2 serve --service` family the webui
 * proxy targets — NOT the PATH `opencode` 1.x, whose /api/plugin is an SPA
 * fallback). Resolution: OPENCODE_ENGINE_BIN wins, else `opencode2` PATH.
 */
function engineBin(): string {
  const override = process.env.OPENCODE_ENGINE_BIN;
  if (override && override.length > 0) return override;
  const found = Bun.spawnSync(["which", "opencode2"]);
  if (found.exitCode === 0) {
    const p = found.stdout.toString().trim().split("\n")[0]?.trim();
    if (p) return p;
  }
  throw new Error("no v2 engine binary: set OPENCODE_ENGINE_BIN or put `opencode2` on PATH");
}

async function waitServiceFile(path: string, timeoutMs: number): Promise<ServiceInfo> {
  const t0 = Date.now();
  let last = "absent";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const raw = readFileSync(path, "utf8");
      const info = JSON.parse(raw) as { url?: unknown; password?: unknown };
      if (typeof info.url === "string" && info.url.length > 0) {
        return { url: info.url.replace(/\/+$/, ""), password: typeof info.password === "string" ? info.password : undefined };
      }
      last = "no url yet";
    } catch (err) {
      last = err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : "unreadable";
    }
    await sleep(400);
  }
  throw new Error(`service.json never appeared at ${path} after ${timeoutMs}ms (last: ${last})`);
}

function authHeaders(info: ServiceInfo): Record<string, string> {
  if (!info.password) return {};
  return { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` };
}

interface PluginEntry {
  id?: string;
  state?: { status?: string; error?: string };
  source?: unknown;
}

async function main(): Promise<void> {
  // --- isolated homes: own config (plugin wiring), state (service.json),
  // --- data (provider creds stay OUT — the probe needs none), and cwd.
  const configHome = join(SCRATCH, "config");
  const stateHome = join(SCRATCH, "state");
  const dataHome = join(SCRATCH, "data");
  const cwd = join(SCRATCH, "cwd");
  for (const d of [join(configHome, "opencode"), join(stateHome, "opencode"), dataHome, cwd]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(
    join(configHome, "opencode", "opencode.jsonc"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [FIXTURE_DIR] }, null, 2),
  );

  // --- E1: boot the probe engine (own port, own XDG dirs, own cwd) ---------
  // `serve --service` writes the registration file (url + password) under
  // the ISOLATED XDG_STATE_HOME — the live engine's file is never touched.
  const port = freePort();
  {
    const t0 = Date.now();
    let bin: string;
    try {
      bin = engineBin();
    } catch (err) {
      rows.push({
        label: "E1 probe engine boots isolated",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        secs: Date.now() - t0,
      });
      return;
    }
    engineProc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--service"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
      },
    });
    const pump = async (s: ReadableStream<Uint8Array> | null): Promise<void> => {
      if (!s) return;
      const reader = s.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) engineLog += new TextDecoder().decode(value);
        }
      } catch {
        /* torn down with the child */
      }
    };
    void pump(engineProc.stdout);
    void pump(engineProc.stderr);
    try {
      const svc = await waitServiceFile(join(stateHome, "opencode", "service.json"), 60_000);
      (globalThis as unknown as { __probeService: ServiceInfo }).__probeService = svc;
      rows.push({
        label: "E1 probe engine boots isolated",
        status: "PASS",
        detail: `serve on :${port}, service.json url=${svc.url} (own XDG dirs under ${SCRATCH})`,
        secs: Date.now() - t0,
      });
    } catch (err) {
      rows.push({
        label: "E1 probe engine boots isolated",
        status: "FAIL",
        detail: `${err instanceof Error ? err.message : String(err)}\nengine log tail:\n${engineLog.slice(-1_200)}`,
        secs: Date.now() - t0,
      });
      return;
    }
  }
  const svc = (globalThis as unknown as { __probeService: ServiceInfo }).__probeService;

  // --- E2: /api/plugin lists the fixture, state active (poll — lazy) ------
  {
    const t0 = Date.now();
    let entry: PluginEntry | null = null;
    let last = "no response";
    const t1 = Date.now();
    while (Date.now() - t1 < PLUGIN_TIMEOUT_MS) {
      try {
        const res = await fetch(`${svc.url}/api/plugin`, {
          headers: authHeaders(svc),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          last = `HTTP ${res.status}`;
        } else {
          const body = (await res.json()) as { data?: PluginEntry[] };
          const ids = (body.data ?? []).map((e) => e.id ?? "?");
          last = `ids: ${ids.join(",") || "none"}`;
          const hit = (body.data ?? []).find((e) => e.id === FIXTURE_ID);
          if (hit) {
            entry = hit;
            break;
          }
        }
      } catch (err) {
        last = err instanceof Error ? err.message.slice(0, 80) : String(err);
      }
      await sleep(1_000);
    }
    if (!entry) {
      rows.push({
        label: "E2 /api/plugin lists the fixture",
        status: "FAIL",
        detail: `id "${FIXTURE_ID}" never appeared within ${PLUGIN_TIMEOUT_MS / 1_000}s (last: ${last})\nengine log tail:\n${engineLog.slice(-1_200)}`,
        secs: Date.now() - t0,
      });
    } else if (entry.state?.status !== "active") {
      rows.push({
        label: "E2 /api/plugin lists the fixture",
        status: "FAIL",
        detail: `listed but state=${JSON.stringify(entry.state)} (want {"status":"active"}); source=${JSON.stringify(entry.source)?.slice(0, 200)}`,
        secs: Date.now() - t0,
      });
    } else {
      rows.push({
        label: "E2 /api/plugin lists the fixture (active)",
        status: "PASS",
        detail: `id "${FIXTURE_ID}" state=active source=${JSON.stringify(entry.source)?.slice(0, 200)}`,
        secs: Date.now() - t0,
      });
    }
  }

  // --- E3/E4: execute the payload in-process via a stub api ----------------
  // (No headless tool-execute route exists on the engine, and model
  // execution needs provider credentials the isolated probe deliberately
  // lacks. E2 proves the engine ACCEPTS the v2 shape; here the same files
  // prove the payload BEHAVES.)
  {
    const t0 = Date.now();
    try {
      const require = createRequire(join(ROOT, "scripts", "uitest", "engine-probe.ts"));
      const mod = require(join(FIXTURE_DIR, "index.js")) as {
        id?: unknown;
        setup?: unknown;
      };
      if (mod.id !== FIXTURE_ID || typeof mod.setup !== "function") {
        throw new Error(`export shape wrong: id=${JSON.stringify(mod.id)} setup=${typeof mod.setup}`);
      }
      const tools: Array<Record<string, unknown>> = [];
      let contextHook: ((m: { system?: unknown[] }) => void) | null = null;
      const stubApi = {
        session: {
          hook: async (_event: string, fn: (m: { system?: unknown[] }) => void) => {
            contextHook = fn;
          },
        },
        tool: {
          transform: async (fn: (t: { add: (d: Record<string, unknown>) => void }) => void) => {
            fn({ add: (d) => tools.push(d) });
          },
        },
      };
      await (mod.setup as (api: unknown) => Promise<unknown>)(stubApi);

      // E3: exactly one tool, executes to { output }.
      const tool = tools.find((t) => t.name === "webui_fixture_ping");
      if (!tool) {
        rows.push({ label: "E3 tool executes to {output}", status: "FAIL", detail: `tool "webui_fixture_ping" not registered (got: ${tools.map((t) => String(t.name)).join(",") || "none"})`, secs: Date.now() - t0 });
      } else if (typeof tool.execute !== "function") {
        rows.push({ label: "E3 tool executes to {output}", status: "FAIL", detail: "registered tool has no execute fn", secs: Date.now() - t0 });
      } else {
        const out = (await (tool.execute as (a: unknown) => unknown)({ text: "hello-seam" })) as Record<string, unknown>;
        const ok = out !== null && typeof out === "object" && typeof out.output === "string" && (out.output as string).includes("pong: hello-seam");
        rows.push({
          label: "E3 tool executes to {output}",
          status: ok ? "PASS" : "FAIL",
          detail: ok ? `execute({text}) → ${JSON.stringify(out)}` : `bad result (want { output: "pong: …" }): ${JSON.stringify(out)?.slice(0, 200)}`,
          secs: Date.now() - t0,
        });
      }

      // E4: system hint is { type: "text", text }.
      if (!contextHook) {
        rows.push({ label: "E4 system hint is {type:text}", status: "FAIL", detail: "no session context hook registered", secs: Date.now() - t0 });
      } else {
        const m: { system: unknown[] } = { system: [] };
        (contextHook as (mm: { system: unknown[] }) => void)(m);
        const part = m.system[0] as Record<string, unknown> | undefined;
        const ok = m.system.length === 1 && part?.type === "text" && typeof part?.text === "string";
        rows.push({
          label: "E4 system hint is {type:text}",
          status: ok ? "PASS" : "FAIL",
          detail: ok ? `system[0] = { type: "text", text: ${(JSON.stringify(part?.text) ?? "").slice(0, 80)}… }` : `bad part: ${JSON.stringify(part)?.slice(0, 200)}`,
          secs: Date.now() - t0,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      rows.push({ label: "E3/E4 payload behaviour (stub api)", status: "FAIL", detail: msg.slice(0, 1_000), secs: Date.now() - t0 });
    }
  }
}

function report(): void {
  const width = Math.max(...rows.map((r) => r.label.length), 20);
  console.log("\n=== engine-seam probe battery ===");
  for (const r of rows) {
    const secs = r.secs !== undefined ? ` (${(r.secs / 1000).toFixed(1)}s)` : "";
    console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}${secs}`);
    if (r.detail) {
      for (const line of r.detail.split("\n")) console.log(`     ${line}`);
    }
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  console.log(`\nRESULT: ${pass} pass · ${fail} fail → exit ${fail > 0 ? 1 : 0}`);
}

let code = 0;
try {
  await main();
} catch (err) {
  rows.push({
    label: "SETUP (fatal)",
    status: "FAIL",
    detail: ((err instanceof Error ? (err.stack ?? err.message) : String(err)) + (engineLog.trim() ? `\nengine log tail:\n${engineLog.slice(-1_200)}` : "")).slice(0, 2_000),
  });
  code = 1;
} finally {
  await cleanup();
  report();
}
await sleep(50);
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : code);
