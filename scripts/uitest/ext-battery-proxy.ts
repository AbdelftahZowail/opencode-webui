#!/usr/bin/env bun
/**
 * PROXY-stratum E2E battery (spec §8).
 *
 *   bun run scripts/uitest/ext-battery-proxy.ts
 *
 * Spawns an ISOLATED proxy (`server/index.ts` on port 4113, never touching
 * the developer's instance on 4097/4099 or their extension dirs) and walks
 * the proxy stratum end to end with real files, real HTTP, no browser:
 *
 *   1  routes 200 + unknown id/route → 404 (never proxied to the engine)
 *   2  middleware onRequest short-circuit (Response) + replace (Request)
 *   3  middleware onResponse header on an engine passthrough
 *   4  onEvent tap firing headless (POST /api/session + prompt + interrupt,
 *      no browser open anywhere near this proxy)
 *   5  pollers ticking headless
 *   6  KV set/get/all namespaced per extension id
 *   7  server.ts hot reload serving NEW code without a restart
 *      (bare-path `?v=` — regression guard for the file:// stale bug)
 *   8  poller no-duplication after the hot edit (old timers disposed)
 *   9  KV persistence across a proxy restart
 *   10 disabled:true unloads routes + browser bundle 404s
 *   11 engine/ payload carried without loading (no crash, ignored)
 *   12 source guard: registry.ts uses bare-path cache-bust, not file://
 *
 * Isolation: WEBUI_EXTENSION_DIR=/tmp/opencode/bat-proxy,
 * WEBUI_PROXY_PORT=4113, WEBUI_SANDBOX=1 (passwordless loopback, no login
 * needed). XDG_STATE_HOME is redirected to /tmp/opencode/bat-proxy-state
 * so the KV persistence check never touches the user's real
 * ~/.local/state/opencode-webui/ext-kv.json.
 *
 * Cleanup is unconditional (finally): proxy tree killed, scratch dirs
 * removed, engine test session deleted. Exit 0 iff zero FAILs.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EXT_ROOT = "/tmp/opencode/bat-proxy";
const STATE_DIR = "/tmp/opencode/bat-proxy-state";
const SCRATCH = "/tmp/opencode";
const PROXY_PORT = 4113;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const SERVER_LOG = join(SCRATCH, "ext-battery-proxy.log");

const BAT = "bat-proxy";
const PEER = "bat-peer";
const DISABLE = "bat-disable";
const ENGINE = "bat-engine";

// ---------------------------------------------------------------------------
// Rows + tiny helpers
// ---------------------------------------------------------------------------

interface Row {
  label: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
  secs?: number;
}
const rows: Row[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fail(label: string, detail: string, t0: number): void {
  rows.push({ label, status: "FAIL", detail, secs: Date.now() - t0 });
}
function pass(label: string, detail: string, t0: number): void {
  rows.push({ label, status: "PASS", detail, secs: Date.now() - t0 });
}

/** Last-N-bytes capture of the proxy output, for failure reports. */
class Capture {
  out = "";
  push(chunk: Uint8Array): void {
    this.out = (this.out + new TextDecoder().decode(chunk)).slice(-24_000);
  }
  tail(max = 1_200): string {
    const t = this.out.trim();
    return t.length > max ? `…${t.slice(-max)}` : t;
  }
}
const cap = new Capture();

async function pump(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) cap.push(value);
    }
  } catch {
    /* torn down with the child */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PIDs listening on a port (ours by construction — we picked the port). */
function listenersOn(port: number): number[] {
  try {
    const ps = Bun.spawnSync(["ss", "-ltnpH"]);
    if (ps.exitCode !== 0) return [];
    const pids: number[] = [];
    for (const line of ps.stdout.toString().split("\n")) {
      if (!line.includes(`:${port} `)) continue;
      const m = line.match(/pid=(\d+)/);
      const pid = m?.[1] ? Number(m[1]) : 0;
      if (pid > 0 && !pids.includes(pid)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

async function sweepPort(port: number): Promise<void> {
  for (const pid of listenersOn(port)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 3_000) {
    if (listenersOn(port).length === 0) return;
    await sleep(200);
  }
  for (const pid of listenersOn(port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Proxy lifecycle (isolated env, own ports)
// ---------------------------------------------------------------------------

let proxyProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;

function proxyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["WEBUI_EXTENSION_DIR"] = EXT_ROOT;
  env["WEBUI_PROXY_PORT"] = String(PROXY_PORT);
  env["WEBUI_SANDBOX"] = "1";
  env["XDG_STATE_HOME"] = STATE_DIR;
  env["WEBUI_DEBUG_LOG"] = SERVER_LOG;
  return env;
}

async function startProxy(): Promise<number> {
  proxyProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: proxyEnv(),
  });
  void pump(proxyProc.stdout);
  void pump(proxyProc.stderr);
  return proxyProc.pid;
}

async function stopProxy(): Promise<void> {
  const proc = proxyProc;
  proxyProc = null;
  if (!proc) return;
  try {
    if (pidAlive(proc.pid)) process.kill(proc.pid, "SIGTERM");
  } catch {
    /* gone */
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 4_000 && pidAlive(proc.pid)) await sleep(150);
  try {
    if (pidAlive(proc.pid)) process.kill(proc.pid, "SIGKILL");
  } catch {
    /* gone */
  }
  await Promise.race([proc.exited.catch(() => undefined), sleep(2_000)]);
}

async function waitProxyReady(timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  let last = "no response";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/webui/config`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 80) : String(err);
    }
    await sleep(400);
  }
  throw new Error(`proxy not ready after ${timeoutMs}ms (last: ${last})\n${cap.tail(800)}`);
}

async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 500,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch {
      /* try again */
    }
    await sleep(stepMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fixtures: the throwaway proxy extensions (no core imports — the loader
// validates server.ts structurally, so fixtures stay dependency-free)
// ---------------------------------------------------------------------------

const MAIN_SERVER_V1 = `let polls = 0;
let events = 0;
let shortHits = 0;
let replaceHits = 0;
let lastSessionIDs = [];

export default {
  routes: [
    { method: "GET", path: "hello", handler: async () => Response.json({ ok: true, version: "v1" }) },
    { method: "GET", path: "counts", handler: async () => Response.json({ polls, events, shortHits, replaceHits }) },
    { method: "GET", path: "events", handler: async () => Response.json({ count: events, lastSessionIDs: lastSessionIDs.slice(-20) }) },
    { method: "GET", path: "kv/set", handler: async (req, ctx) => {
        const u = new URL(req.url);
        const k = u.searchParams.get("k") || "";
        const v = u.searchParams.get("v") || "";
        if (!k) return Response.json({ error: "k required" }, { status: 400 });
        await ctx.kv.set(k, v);
        return Response.json({ ok: true });
      } },
    { method: "GET", path: "kv/get", handler: async (req, ctx) => {
        const u = new URL(req.url);
        const k = u.searchParams.get("k") || "";
        return Response.json({ value: ctx.kv.get(k) !== undefined ? ctx.kv.get(k) : null });
      } },
    { method: "GET", path: "kv/all", handler: async (_req, ctx) => Response.json({ data: ctx.kv.all() }) },
  ],
  middleware: {
    onRequest: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/bat-shortcircuit") { shortHits++; return Response.json({ short: true }); }
      if (u.pathname === "/api/bat-replace-probe") {
        replaceHits++;
        const h = new Headers(req.headers);
        h.set("x-bat-replaced", "1");
        return new Request(req, { headers: h });
      }
      if (u.pathname === "/api/session" && req.method === "GET" && u.searchParams.get("bat-replace") === "1") {
        replaceHits++;
        const h2 = new Headers(req.headers);
        h2.set("x-bat-replaced", "1");
        return new Request(req, { headers: h2 });
      }
    },
    onResponse: async (res, req) => {
      const u = new URL(req.url);
      if (u.pathname.indexOf("/api/session") === 0 || u.pathname === "/api/bat-replace-probe") {
        const h = new Headers(res.headers);
        h.set("x-bat-proxy", "1");
        return new Response(res.body, { status: res.status, headers: h });
      }
    },
  },
  onEvent: async (evt, ctx) => {
    events++;
    const d = evt.data;
    if (d && typeof d === "object") {
      const sid = d.sessionID;
      if (typeof sid === "string" && sid) {
        lastSessionIDs.push(sid);
        if (lastSessionIDs.length > 50) lastSessionIDs.shift();
      }
    }
    try { await ctx.kv.set("lastEvent", String(evt.type || "")); } catch (_e) { /* ignore */ }
  },
  pollers: [
    { id: "tick", intervalMs: 500, run: async (ctx) => {
        polls++;
        try { await ctx.kv.set("tickCount", polls); } catch (_e) { /* ignore */ }
      } },
  ],
};
`;

const PEER_SERVER = `export default {
  routes: [
    { method: "GET", path: "kv/set", handler: async (req, ctx) => {
        const u = new URL(req.url);
        const k = u.searchParams.get("k") || "";
        const v = u.searchParams.get("v") || "";
        if (!k) return Response.json({ error: "k required" }, { status: 400 });
        await ctx.kv.set(k, v);
        return Response.json({ ok: true });
      } },
    { method: "GET", path: "kv/all", handler: async (_req, ctx) => Response.json({ data: ctx.kv.all() }) },
  ],
};
`;

const DISABLE_SERVER = `export default {
  routes: [
    { method: "GET", path: "ping", handler: async () => Response.json({ ok: true }) },
  ],
};
`;

// User-dir browser entry: the window.__opencodeUI bridge (external dirs
// cannot import the in-repo registry path — same pattern as
// scripts/uitest/extensions-check.ts phase D).
const DISABLE_INDEX = `const ui = window.__opencodeUI;
if (ui && typeof ui.register === "function") {
  ui.register({ kind: "contribute", id: "bat-disable-cmd", collection: "palette", item: { title: "Bat disable", run: () => {} } });
}
`;

const ENGINE_SERVER = `export default {
  routes: [
    { method: "GET", path: "ping", handler: async () => Response.json({ ok: true, engineIgnored: true }) },
  ],
};
`;

const ENGINE_DUMMY = `// Dummy engine payload: the webui must carry this folder without loading it.
// Engine plugin rules apply; the proxy stratum ignores engine/ entirely.
export const BAT_ENGINE_DUMMY = true;
`;

function manifest(id: string, disabled = false): string {
  return JSON.stringify(
    disabled
      ? { id, name: id, version: "1.0.0", description: `battery fixture ${id}`, disabled: true }
      : { id, name: id, version: "1.0.0", description: `battery fixture ${id}` },
    null,
    2,
  );
}

function extGet(id: string, suffix: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}/api/webui/ext/${id}/${suffix}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
}

async function extJSON(id: string, suffix: string): Promise<{ status: number; body: unknown }> {
  const res = await extGet(id, suffix);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, body };
}

/**
 * Engine discovery lives at $XDG_STATE_HOME/opencode/service.json
 * (Service.ensure). The battery redirects XDG_STATE_HOME to a scratch dir
 * for KV isolation, so symlink the REAL `opencode/` state subdir in — live
 * service discovery keeps working while `opencode-webui/ext-kv.json` stays
 * isolated. Only the symlink is created; the target is never written.
 */
function ensureEngineDiscoveryLink(): void {
  const realState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const target = join(realState, "opencode");
  const link = join(STATE_DIR, "opencode");
  if (existsSync(link)) return;
  mkdirSync(STATE_DIR, { recursive: true });
  symlinkSync(target, link);
}

function writeFixtures(): void {
  for (const id of [BAT, PEER, DISABLE, ENGINE]) {
    mkdirSync(join(EXT_ROOT, id), { recursive: true });
  }
  writeFileSync(join(EXT_ROOT, BAT, "manifest.json"), manifest(BAT));
  writeFileSync(join(EXT_ROOT, BAT, "server.ts"), MAIN_SERVER_V1);
  writeFileSync(join(EXT_ROOT, PEER, "manifest.json"), manifest(PEER));
  writeFileSync(join(EXT_ROOT, PEER, "server.ts"), PEER_SERVER);
  writeFileSync(join(EXT_ROOT, DISABLE, "manifest.json"), manifest(DISABLE));
  writeFileSync(join(EXT_ROOT, DISABLE, "server.ts"), DISABLE_SERVER);
  writeFileSync(join(EXT_ROOT, DISABLE, "index.tsx"), DISABLE_INDEX);
  writeFileSync(join(EXT_ROOT, ENGINE, "manifest.json"), manifest(ENGINE));
  writeFileSync(join(EXT_ROOT, ENGINE, "server.ts"), ENGINE_SERVER);
  mkdirSync(join(EXT_ROOT, ENGINE, "engine"), { recursive: true });
  writeFileSync(join(EXT_ROOT, ENGINE, "engine", "tool.ts"), ENGINE_DUMMY);
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

let engineSessionID: string | null = null;

async function main(): Promise<void> {
  mkdirSync(SCRATCH, { recursive: true });
  rmSync(EXT_ROOT, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(EXT_ROOT, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  ensureEngineDiscoveryLink();
  writeFixtures();
  await sweepPort(PROXY_PORT);

  // --- SETUP: isolated proxy, no browser anywhere ---
  {
    const t0 = Date.now();
    await startProxy();
    await waitProxyReady(45_000);
    const hello = await extJSON(BAT, "hello");
    const helloBody = hello.body as { version?: string } | null;
    if (hello.status !== 200 || (helloBody as { version?: string } | null)?.version !== "v1") {
      fail(
        "SETUP isolated proxy + fixtures",
        `hello probe failed: HTTP ${hello.status} ${JSON.stringify(hello.body).slice(0, 200)}\n${cap.tail(600)}`,
        t0,
      );
      throw new Error("setup failed — aborting battery");
    }
    pass(
      "SETUP isolated proxy + fixtures",
      `port ${PROXY_PORT}, WEBUI_EXTENSION_DIR=${EXT_ROOT}, SANDBOX=1 — 4 fixtures loaded, zero browsers`,
      t0,
    );
  }

  // --- 1: routes 200 ---
  {
    const t0 = Date.now();
    const r = await extJSON(BAT, "hello");
    const body = r.body as { ok?: boolean; version?: string };
    if (r.status === 200 && body?.ok === true && body?.version === "v1") {
      pass("1  ext route 200", `GET /api/webui/ext/${BAT}/hello → 200 {ok,version:v1}`, t0);
    } else {
      fail("1  ext route 200", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`, t0);
    }
  }

  // --- 2: unknown extension id → 404, never proxied ---
  {
    const t0 = Date.now();
    const res = await extGet("no-such-ext", "anything");
    const text = await res.text();
    let body: { error?: string } = {};
    try {
      body = JSON.parse(text) as { error?: string };
    } catch {
      /* raw */
    }
    // The engine answers unknown /api paths with an EMPTY 404; the proxy's
    // ext fallback answers JSON {error:"unknown extension route"} — the body
    // proves the request never reached the engine.
    if (res.status === 404 && body?.error === "unknown extension route") {
      pass("2  unknown ext id → 404 (not proxied)", `HTTP 404 {error:"unknown extension route"} — proxy-owned, engine never hit`, t0);
    } else {
      fail("2  unknown ext id → 404 (not proxied)", `HTTP ${res.status} ${text.slice(0, 200)}`, t0);
    }
  }

  // --- 3: unknown route under a KNOWN id → 404 too ---
  {
    const t0 = Date.now();
    const res = await extGet(BAT, "no-such-route");
    const text = await res.text();
    if (res.status === 404 && text.includes("unknown extension route")) {
      pass("3  unknown route → 404 (not proxied)", `GET /api/webui/ext/${BAT}/no-such-route → 404 proxy-owned`, t0);
    } else {
      fail("3  unknown route → 404 (not proxied)", `HTTP ${res.status} ${text.slice(0, 200)}`, t0);
    }
  }

  // --- 4: onRequest short-circuit (Response wins without touching engine) ---
  {
    const t0 = Date.now();
    // The engine has no /api/bat-shortcircuit (it 404s empty) — a 200 here
    // can only come from the middleware short-circuit.
    const res = await fetch(`${BASE}/api/bat-shortcircuit`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { short?: boolean } | null;
    const counts = (await extJSON(BAT, "counts")).body as { shortHits?: number };
    if (res.status === 200 && body?.short === true && (counts?.shortHits ?? 0) >= 1) {
      pass("4  onRequest short-circuit", `GET /api/bat-shortcircuit → 200 {short:true}, shortHits=${String(counts?.shortHits)}`, t0);
    } else {
      fail(
        "4  onRequest short-circuit",
        `HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)} shortHits=${String(counts?.shortHits)}`,
        t0,
      );
    }
  }

  // --- 5: onRequest replace (Request passes through, still hits engine) ---
  {
    const t0 = Date.now();
    // Engine 404s this path with an EMPTY body — passthrough proves the
    // returned Request was honored (not short-circuited), and onResponse
    // still ran (x-bat-proxy header below).
    const res = await fetch(`${BASE}/api/bat-replace-probe`, { signal: AbortSignal.timeout(10_000) });
    await res.text().catch(() => "");
    const counts = (await extJSON(BAT, "counts")).body as { replaceHits?: number };
    const hdr = res.headers.get("x-bat-proxy");
    if (res.status === 404 && (counts?.replaceHits ?? 0) >= 1 && hdr === "1") {
      pass(
        "5  onRequest replace",
        `GET /api/bat-replace-probe → engine 404 passthrough (not short-circuit), replaceHits=${String(counts?.replaceHits)}, x-bat-proxy:1`,
        t0,
      );
    } else {
      fail(
        "5  onRequest replace",
        `HTTP ${res.status} replaceHits=${String(counts?.replaceHits)} x-bat-proxy=${hdr ?? "missing"}`,
        t0,
      );
    }
  }

  // --- 6: onResponse header on a REAL engine passthrough ---
  {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/session?limit=1`, { signal: AbortSignal.timeout(10_000) });
    await res.text().catch(() => "");
    if (res.status === 200 && res.headers.get("x-bat-proxy") === "1") {
      pass("6  onResponse header (engine passthrough)", `GET /api/session?limit=1 → 200 + x-bat-proxy:1, body intact`, t0);
    } else {
      fail("6  onResponse header (engine passthrough)", `HTTP ${res.status} x-bat-proxy=${res.headers.get("x-bat-proxy") ?? "missing"}`, t0);
    }
  }

  // --- 7: KV set/get/all, namespaced per extension ---
  {
    const t0 = Date.now();
    const key = `ns-${Date.now().toString(36)}`;
    await extGet(BAT, `kv/set?k=${encodeURIComponent(key)}&v=main`);
    const got = (await extJSON(BAT, `kv/get?k=${encodeURIComponent(key)}`)).body as { value?: unknown };
    const allMain = (await extJSON(BAT, "kv/all")).body as { data?: Record<string, unknown> };
    const allPeer = (await extJSON(PEER, "kv/all")).body as { data?: Record<string, unknown> };
    const mainHas = allMain?.data?.[key] === "main";
    const peerLacks = !(allPeer?.data && key in allPeer.data);
    // Cross-direction: peer's key must not leak into main's namespace either.
    const pkey = `peer-${Date.now().toString(36)}`;
    await extGet(PEER, `kv/set?k=${encodeURIComponent(pkey)}&v=peer`);
    const allMain2 = (await extJSON(BAT, "kv/all")).body as { data?: Record<string, unknown> };
    const mainLacksPeer = !(allMain2?.data && pkey in allMain2.data);
    if (got?.value === "main" && mainHas && peerLacks && mainLacksPeer) {
      pass("7  KV set/get/all + namespaced", `main↔peer namespaces isolated both ways (${key}, ${pkey})`, t0);
    } else {
      fail(
        "7  KV set/get/all + namespaced",
        `get=${JSON.stringify(got).slice(0, 120)} mainHas=${mainHas} peerLacks=${peerLacks} mainLacksPeer=${mainLacksPeer}`,
        t0,
      );
    }
  }

  // --- 8: onEvent tap fires headless (session + prompt + interrupt) ---
  let prePollsForDupCheck = 0;
  {
    const t0 = Date.now();
    const before = (await extJSON(BAT, "events")).body as { count?: number; lastSessionIDs?: string[] };
    const beforeCount = typeof before?.count === "number" ? before.count : 0;
    // Create + prompt + interrupt through OUR proxy (headless — this script
    // never opens a browser; the proxy's recorder is the only subscriber).
    const created = await fetch(`${BASE}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "bat-proxy-tap", agent: null, model: null, location: null }),
      signal: AbortSignal.timeout(15_000),
    });
    const createdBody = (await created.json().catch(() => null)) as { data?: { id?: string } } | null;
    const sid = createdBody?.data?.id;
    if (created.status !== 200 || !sid) {
      fail("8  onEvent tap headless", `session create failed: HTTP ${created.status}`, t0);
    } else {
      engineSessionID = sid;
      await fetch(`${BASE}/api/session/${sid}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Reply with exactly BAT-OK and stop." }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      await sleep(3_000);
      await fetch(`${BASE}/api/session/${sid}/interrupt`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const seen = await pollUntil(async () => {
        const cur = (await extJSON(BAT, "events")).body as { count?: number; lastSessionIDs?: string[] };
        return Array.isArray(cur?.lastSessionIDs) && cur.lastSessionIDs.includes(sid);
      }, 40_000, 1_000);
      const after = (await extJSON(BAT, "events")).body as { count?: number };
      const afterCount = typeof after?.count === "number" ? after.count : 0;
      // Poller baseline for the later no-duplication check (same process).
      const counts = (await extJSON(BAT, "counts")).body as { polls?: number };
      prePollsForDupCheck = typeof counts?.polls === "number" ? counts.polls : 0;
      if (seen && afterCount > beforeCount) {
        pass(
          "8  onEvent tap headless",
          `sid ${sid.slice(0, 18)}… observed by tap (${beforeCount}→${afterCount}), prompt+interrupt, zero browsers`,
          t0,
        );
      } else {
        fail("8  onEvent tap headless", `seen=${seen} count ${beforeCount}→${afterCount} (sid ${String(sid).slice(0, 24)})`, t0);
      }
      await fetch(`${BASE}/api/session/${sid}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => null);
      engineSessionID = null;
    }
  }

  // --- 9: pollers tick headless ---
  let pollsBeforeEdit = 0;
  let pollsBeforeEditDelta = 0;
  {
    const t0 = Date.now();
    const c1 = (await extJSON(BAT, "counts")).body as { polls?: number };
    const p1 = typeof c1?.polls === "number" ? c1.polls : 0;
    await sleep(2_200);
    const c2 = (await extJSON(BAT, "counts")).body as { polls?: number };
    const p2 = typeof c2?.polls === "number" ? c2.polls : 0;
    pollsBeforeEdit = p2;
    pollsBeforeEditDelta = p2 - p1;
    void prePollsForDupCheck;
    if (p2 - p1 >= 2) {
      pass("9  pollers tick headless", `tick +${p2 - p1} in ~2.2s @500ms interval, no browser open`, t0);
    } else {
      fail("9  pollers tick headless", `only +${p2 - p1} in ~2.2s (poller stalled?)`, t0);
    }
  }

  // --- 10: server.ts hot reload serves NEW code without a restart ---
  {
    const t0 = Date.now();
    const pidBefore = proxyProc?.pid ?? -1;
    const path = join(EXT_ROOT, BAT, "server.ts");
    const src = readFileSync(path, "utf8");
    if (!src.includes('version: "v1"')) {
      fail("10 hot reload (no restart)", `fixture no longer contains v1 marker — cannot edit`, t0);
    } else {
      writeFileSync(path, src.replace('version: "v1"', 'version: "v2"'));
      const flipped = await pollUntil(async () => {
        const cur = (await extJSON(BAT, "hello")).body as { version?: string };
        return cur?.version === "v2";
      }, 15_000, 500);
      const pidAfter = proxyProc?.pid ?? -2;
      const pidSame = pidBefore > 0 && pidAfter === pidBefore && pidAlive(pidAfter);
      if (flipped && pidSame) {
        pass("10 hot reload (no restart)", `hello v1→v2 via stat-poll re-import (?v= bust), same proxy pid ${pidAfter}`, t0);
      } else {
        fail("10 hot reload (no restart)", `flipped=${flipped} pid ${pidBefore}→${pidAfter} alive=${pidAfter > 0 && pidAlive(pidAfter)}`, t0);
      }
    }
  }

  // --- 11: source guard for the bare-path ?v= fix (file:// serves stale) ---
  {
    const t0 = Date.now();
    const reg = readFileSync(join(ROOT, "server", "ext", "registry.ts"), "utf8");
    const hasBareBust = reg.includes("entry}?v=") || reg.includes("?v=${mtimeMs}");
    const usesFileURLImport = reg.includes("pathToFileURL") || reg.includes("fileURLToPath(new URL(entry");
    if (hasBareBust && !usesFileURLImport) {
      pass("11 bare-path ?v= guard", `registry.ts re-imports via bare path + ?v=mtime (file:// only in the stale-bug comment)`, t0);
    } else {
      fail("11 bare-path ?v= guard", `bareBust=${hasBareBust} fileURLImport=${usesFileURLImport}`, t0);
    }
  }

  // --- 12: no poller duplication after the hot edit ---
  {
    const t0 = Date.now();
    // The swap path stops the old module's timers BEFORE installing the new
    // one — a leaked timer would ~double the 500ms rate (~8-10 per 2.4s).
    const c1 = (await extJSON(BAT, "counts")).body as { polls?: number };
    const p1 = typeof c1?.polls === "number" ? c1.polls : 0;
    await sleep(2_400);
    const c2 = (await extJSON(BAT, "counts")).body as { polls?: number };
    const p2 = typeof c2?.polls === "number" ? c2.polls : 0;
    const delta = p2 - p1;
    const notDoubled = pollsBeforeEditDelta <= 0 || delta <= pollsBeforeEditDelta * 2;
    if (delta >= 2 && delta <= 7 && notDoubled) {
      pass("12 poller no-duplication post-edit", `tick +${delta} in ~2.4s after edit (pre-edit +${pollsBeforeEditDelta}); single timer, old disposed`, t0);
    } else {
      fail(
        "12 poller no-duplication post-edit",
        `tick +${delta} in ~2.4s after edit (pre-edit +${pollsBeforeEditDelta}, snapshots ${pollsBeforeEdit}→${p1}→${p2}) — duplication or stall`,
        t0,
      );
    }
  }

  // --- 13: KV persistence across a proxy restart ---
  {
    const t0 = Date.now();
    const pkey = `persist-${Date.now().toString(36)}`;
    const pval = `v-${Math.random().toString(36).slice(2, 8)}`;
    await extGet(BAT, `kv/set?k=${encodeURIComponent(pkey)}&v=${encodeURIComponent(pval)}`);
    const kvFile = join(STATE_DIR, "opencode-webui", "ext-kv.json");
    const fileBefore = existsSync(kvFile);
    await stopProxy();
    await sweepPort(PROXY_PORT);
    await startProxy();
    await waitProxyReady(45_000);
    const helloOk = await pollUntil(async () => {
      const cur = (await extJSON(BAT, "hello")).body as { version?: string };
      return cur?.version === "v2";
    }, 15_000, 500);
    const got = (await extJSON(BAT, `kv/get?k=${encodeURIComponent(pkey)}`)).body as { value?: unknown };
    if (helloOk && fileBefore && got?.value === pval) {
      pass("13 KV persistence across restart", `key ${pkey}=${pval} survived kill+respawn (file ${kvFile} reloaded)`, t0);
    } else {
      fail("13 KV persistence across restart", `helloV2=${helloOk} fileBefore=${fileBefore} got=${JSON.stringify(got).slice(0, 120)}`, t0);
    }
  }

  // --- 14: disabled:true unloads routes ---
  {
    const t0 = Date.now();
    const pre = await extGet(DISABLE, "ping");
    await pre.text().catch(() => "");
    const preOk = pre.status === 200;
    writeFileSync(join(EXT_ROOT, DISABLE, "manifest.json"), manifest(DISABLE, true));
    const unloaded = await pollUntil(async () => (await extGet(DISABLE, "ping")).status === 404, 15_000, 500);
    if (preOk && unloaded) {
      pass("14 disabled:true unloads routes", `ping 200 → manifest disabled:true → 404 (paused, no folder delete)`, t0);
    } else {
      fail("14 disabled:true unloads routes", `pre200=${preOk} unloaded=${unloaded}`, t0);
    }
  }

  // --- 15: disabled bundle 404s (page must never import paused code) ---
  {
    const t0 = Date.now();
    // Re-enable briefly to prove the bundle exists when enabled, then pause.
    // (Phase 14 already paused it; flip back, confirm 200, pause again.)
    writeFileSync(join(EXT_ROOT, DISABLE, "manifest.json"), manifest(DISABLE, false));
    const served = await pollUntil(async () => {
      const r = await fetch(`${BASE}/api/webui/extensions/${DISABLE}/bundle.js`, { signal: AbortSignal.timeout(10_000) });
      await r.text().catch(() => "");
      return r.status === 200;
    }, 25_000, 1_000);
    writeFileSync(join(EXT_ROOT, DISABLE, "manifest.json"), manifest(DISABLE, true));
    const gone = await pollUntil(async () => {
      const r = await fetch(`${BASE}/api/webui/extensions/${DISABLE}/bundle.js`, { signal: AbortSignal.timeout(10_000) });
      await r.text().catch(() => "");
      return r.status === 404;
    }, 25_000, 1_000);
    if (served && gone) {
      pass("15 disabled bundle → 404", `bundle.js 200 while enabled (bridge code) → 404 after disabled:true`, t0);
    } else {
      fail("15 disabled bundle → 404", `served200=${served} gone404=${gone}`, t0);
    }
  }

  // --- 16: engine/ payload carried, never loaded ---
  {
    const t0 = Date.now();
    const ping = await extJSON(ENGINE, "ping");
    const pingBody = ping.body as { ok?: boolean; engineIgnored?: boolean };
    const cfg = await fetch(`${BASE}/api/webui/config`, { signal: AbortSignal.timeout(10_000) });
    const manRes = await fetch(`${BASE}/api/webui/extensions`, { signal: AbortSignal.timeout(10_000) });
    const manBody = (await manRes.json().catch(() => null)) as { data?: Array<{ id?: string; url?: string }> } | null;
    const engineFileOnDisk = existsSync(join(EXT_ROOT, ENGINE, "engine", "tool.ts"));
    const noEngineBundle = !(manBody?.data ?? []).some((e) => typeof e?.url === "string" && e.url.includes("engine"));
    if (
      ping.status === 200 &&
      pingBody?.ok === true &&
      cfg.status === 200 &&
      manRes.status === 200 &&
      engineFileOnDisk &&
      noEngineBundle
    ) {
      pass("16 engine/ ignored, no crash", `ping 200 (proxy stratum live), config+manifest 200, engine/tool.ts on disk but never bundled`, t0);
    } else {
      fail(
        "16 engine/ ignored, no crash",
        `ping=${ping.status} cfg=${cfg.status} manifest=${manRes.status} onDisk=${engineFileOnDisk} noEngineBundle=${noEngineBundle}`,
        t0,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function report(): void {
  const width = Math.max(...rows.map((r) => r.label.length), 30);
  console.log("\n=== proxy-stratum battery ===");
  for (const r of rows) {
    const secs = r.secs !== undefined ? ` (${(r.secs / 1000).toFixed(1)}s)` : "";
    console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}${secs}`);
    if (r.detail) {
      for (const line of r.detail.split("\n")) console.log(`     ${line}`);
    }
  }
  const passN = rows.filter((r) => r.status === "PASS").length;
  const failN = rows.filter((r) => r.status === "FAIL").length;
  const skipN = rows.filter((r) => r.status === "SKIP").length;
  console.log(`\nRESULT: ${passN} pass · ${failN} fail · ${skipN} skip → exit ${failN > 0 ? 1 : 0}`);
  console.log(`Battery file: scripts/uitest/ext-battery-proxy.ts (isolated proxy :${PROXY_PORT}, no src/ or server/ changes)`);
}

async function cleanup(): Promise<void> {
  if (engineSessionID) {
    await fetch(`${BASE}/api/session/${engineSessionID}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    engineSessionID = null;
  }
  await stopProxy();
  await sweepPort(PROXY_PORT);
  try {
    unlinkSync(join(STATE_DIR, "opencode"));
  } catch {
    /* link already gone — rmSync below handles the rest */
  }
  for (const dir of [EXT_ROOT, STATE_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[ext-battery-proxy] failed to remove ${dir}:`, err);
    }
  }
}

let code = 0;
try {
  await main();
} catch (err) {
  rows.push({
    label: "SETUP (fatal)",
    status: "FAIL",
    detail:
      (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 2_000) +
      (cap.out.trim() ? `\nproxy tail:\n${cap.tail(1_500)}` : ""),
  });
  code = 1;
} finally {
  await cleanup();
  report();
}
await sleep(50);
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : code);
