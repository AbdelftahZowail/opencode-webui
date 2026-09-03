#!/usr/bin/env bun
/**
 * Extension registry contract check — the real lifecycle, in a real browser.
 *
 *   bun run scripts/uitest/extensions-check.ts
 *
 * Spawns an ISOLATED dev instance (`bun run scripts/dev.ts` on free ports,
 * never touching the developer's own instance on 5173/4097 or the engine),
 * drives headless Chrome over CDP, and walks the registry contract end to
 * end — no mocks, the same files a human would drop:
 *
 *   A  hot ADD    drop webui-extensions/zz-contract-check/ into the live tree →
 *                 the sidebar wrap renders its marker, `registered` flips, and
 *                 NO page reload happened (sentinel + bootId prove it).
 *   B  hot EDIT   rewrite the entry (v2, edits:1) → same-id registry swap,
 *                 targets repaint, STILL no reload.
 *   C  REMOVE     delete the folder → its registrations vanish via the
 *                 loader's owned-set unregister at the HMR boundary, with NO
 *                 reload. The report names the cleanup path if a coalesced
 *                 full reload ever fires instead.
 *   D  runtime    the /api/webui/extensions* surface + the
 *                 ~/.config/opencode/webui-extensions/ user-dir pipeline.
 *
 * Findings baked into the flow (re-verify before "fixing" the script):
 *  - Gating: presence = installed, manifest `disabled` = paused — there is
 *    no config list and no per-browser gating, so phases A/B measure the
 *    folder add/edit lifecycle reload-free with zero setup edits.
 *  - Auth: server/auth.ts gates every /api route behind a session cookie
 *    (POST /api/auth/login). The SPA itself is served by VITE unauthenticated
 *    and the app shell mounts fine unauthenticated —
 *    so phases A–C run without login; the script-side /api probes log in
 *    with WEBUI_PASSWORD (the instance is ours: the env var if provided,
 *    else a random one) and carry the cookie. If login is somehow impossible
 *    the server-side phase degrades to a SKIP, never a false FAIL.
 *  - Phase D: server/userExtensions.ts scans
 *    ~/.config/opencode/webui-extensions/<name>/main.tsx (id = folder name)
 *    and merges into the plugin manifest — same Bun.build pipeline. The
 *    phase drops a bridge-registering extension there and asserts the full
 *    path: manifest entry (source user:…) + bundle 200 containing the
 *    registration. There is no browser step here by design: the manifest is
 *    a proxy surface, and bundle EXECUTION in a page is the runtime loader's
 *    job (src/lib/runtimeExtensions.ts).
 *
 * Cleanup is unconditional (finally): temp files/dirs removed, both child
 * trees killed by PID (SIGTERM → SIGKILL), ports re-checked. The transient
 * file edits DO hot-reload any open dev instance watching this repo — that
 * is inherent to testing the real HMR path.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EXT_ID = "zz-contract-check";
const EXT_DIR = join(ROOT, "webui-extensions", EXT_ID);
const EXT_FILE = join(EXT_DIR, "index.tsx");
const USER_DIR = join(homedir(), ".config", "opencode", "webui-extensions", EXT_ID);
const USER_FILE = join(USER_DIR, "main.tsx");
const USER_REG_ID = "zz-user-check";
const CHROME = "/usr/bin/google-chrome";
const SCRATCH = "/tmp/opencode";
const SERVER_LOG = join(SCRATCH, "extensions-check-server.log");
const POLL_MS = 1_000; // per-assertion evaluate cadence
const ASSERT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Row {
  label: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
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

/** Last-N-bytes capture of a child stream, for parsing + failure reports. */
class Capture {
  out = "";
  err = "";
  push(chunk: Uint8Array, stream: "out" | "err"): void {
    const text = new TextDecoder().decode(chunk);
    if (stream === "out") this.out = (this.out + text).slice(-24_000);
    else this.err = (this.err + text).slice(-24_000);
  }
  get all(): string {
    return `${this.out}\n${this.err}`;
  }
  tail(max = 1_200): string {
    const t = this.all.trim();
    return t.length > max ? `…${t.slice(-max)}` : t;
  }
}

async function pump(stream: ReadableStream<Uint8Array> | null, cap: Capture, which: "out" | "err"): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) cap.push(value, which);
    }
  } catch {
    /* stream torn down with the child */
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

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** All descendants of `root` (BFS via ps --ppid), root excluded. */
function listDescendants(root: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([root]);
  let frontier = [root];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const pid of frontier) {
      const ps = Bun.spawnSync(["ps", "-o", "pid=", "--ppid", String(pid)]);
      if (ps.exitCode !== 0) continue;
      for (const line of ps.stdout.toString().split("\n")) {
        const v = Number(line.trim());
        if (Number.isInteger(v) && v > 0 && !seen.has(v)) {
          seen.add(v);
          next.push(v);
        }
      }
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

/** SIGTERM the whole tree, escalate to SIGKILL after 3s. Own PIDs only. */
async function killTree(pid: number, sub: { exited: Promise<number> } | null): Promise<void> {
  if (!pidAlive(pid)) return;
  const desc = listDescendants(pid);
  const leavesFirst = [...desc].reverse();
  for (const p of leavesFirst) signal(p, "SIGTERM");
  signal(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && (pidAlive(pid) || desc.some(pidAlive))) await sleep(150);
  for (const p of [...leavesFirst].reverse()) if (pidAlive(p)) signal(p, "SIGKILL");
  if (pidAlive(pid)) signal(pid, "SIGKILL");
  if (sub) await Promise.race([sub.exited.catch(() => undefined), sleep(2_000)]);
}

/** PIDs (if any) listening on a port we picked — by definition ours to reap. */
function listenersOn(port: number): number[] {
  try {
    const ss = Bun.spawnSync(["ss", "-ltnpH"]);
    if (ss.exitCode !== 0) return [];
    const pids: number[] = [];
    for (const line of ss.stdout.toString().split("\n")) {
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

async function waitHttp(url: string, timeoutMs: number, what: string, init?: RequestInit): Promise<Response> {
  const t0 = Date.now();
  let last = "no response";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3_000) });
      last = `HTTP ${res.status}`;
      if (res.ok) return res;
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 80) : String(err);
    }
    await sleep(400);
  }
  throw new Error(`${what}: not ready after ${timeoutMs}ms (last: ${last})`);
}

// ---------------------------------------------------------------------------
// Proxy auth (server/auth.ts): one login round-trip, then carry the cookie
// ---------------------------------------------------------------------------

let authCookie: string | null = null;

/** Authenticated GET against our proxy instance. */
function apiFetch(path: string): Promise<Response> {
  return fetch(`${MANIFEST_BASE}${path}`, {
    headers: authCookie ? { cookie: authCookie } : undefined,
    signal: AbortSignal.timeout(5_000),
  });
}

/** Login to our own instance and remember the session cookie pair. */
async function loginProxy(password: string): Promise<void> {
  const res = await fetch(`${MANIFEST_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`proxy login failed: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  const pair = setCookie?.split(";")[0]?.trim();
  if (!pair || !pair.startsWith("webui_session=")) {
    throw new Error(`proxy login returned no session cookie (got: ${setCookie?.slice(0, 60) ?? "none"})`);
  }
  authCookie = pair;
}

// ---------------------------------------------------------------------------
// Minimal CDP client over Bun's WebSocket (just enough for this check)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** Captured page console errors/warnings + uncaught exceptions (debug aid). */
  consoleLines: string[] = [];

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`));
          else p.resolve(msg.result);
        }
        return;
      }
      this.tapEvent(msg);
    });
  }

  private tapEvent(msg: any): void {
    const method = msg.method as string | undefined;
    const p = msg.params ?? {};
    if (method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) {
      const text = (p.args ?? [])
        .map((a: any) => a.value ?? a.description ?? a.type)
        .join(" ")
        .slice(0, 300);
      this.consoleLines.push(`console.${p.type}: ${text}`);
    } else if (method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails ?? {};
      this.consoleLines.push(`exception: ${d.text ?? ""} ${d.exception?.description ?? ""}`.slice(0, 300));
    } else if (method === "Log.entryAdded" && p.entry?.level === "error") {
      this.consoleLines.push(`log: ${String(p.entry.text ?? "").slice(0, 300)}`);
    }
    if (this.consoleLines.length > 40) this.consoleLines.splice(0, this.consoleLines.length - 40);
  }

  open(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket: open timeout")), timeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket: error"));
      });
    });
  }

  call(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const res = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      userGesture: true,
      awaitPromise,
    });
    if (res?.exceptionDetails) {
      throw new Error(`evaluate failed: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
    }
    return res?.result?.value;
  }

  /** Poll a boolean expression in the page until true or timeout. */
  async waitFor(
    expression: string,
    label: string,
    timeoutMs = ASSERT_TIMEOUT_MS,
  ): Promise<{ ok: true } | { ok: false; last: unknown }> {
    const t0 = Date.now();
    let last: unknown = "not evaluated";
    while (Date.now() - t0 < timeoutMs) {
      try {
        last = await this.evaluate(expression);
        if (last === true) return { ok: true };
      } catch (err) {
        last = `eval-error: ${err instanceof Error ? err.message : String(err)}`;
      }
      await sleep(POLL_MS);
    }
    console.error(`[extensions-check] timeout waiting for: ${label}`);
    return { ok: false, last };
  }

  consoleTail(max = 12): string {
    return this.consoleLines.slice(-max).join("\n");
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Fixtures: the throwaway extension (v1/v2) and the user-dir candidate
// ---------------------------------------------------------------------------

function extSource(marker: "v1" | "v2"): string {
  const edits = marker === "v1" ? 0 : 1;
  return `import { register } from "../../src/extensions/registry";

export const id = "${EXT_ID}";

// A wrap on the always-mounted sidebar shell: the marker div proves the
// target chain evaluates live registrations without any page reload.
register({
  kind: "wrap",
  id,
  target: "sidebar",
  render: (_props, next) => <><div data-contract-check="${marker}">CONTRACT_CHECK_${marker.toUpperCase()}</div>{next()}</>,
});

register({
  kind: "contribute",
  id: "${EXT_ID}.cmd",
  collection: "palette",
  item: { title: "Contract check", run: () => {} },
});

// Lifecycle probe: bootId survives hot-swaps (module re-run in the same
// window) but NOT a full reload (window wiped) — that is the reload detector.
const w = window as unknown as {
  __contractCheck?: { registered: boolean; edits: number; bootId: number };
};
w.__contractCheck = {
  registered: true,
  edits: ${edits},
  bootId: w.__contractCheck ? w.__contractCheck.bootId : Math.random(),
};

if (import.meta.hot) import.meta.hot.accept();
`;
}

/** What the task's Phase D drops into the user dir — via the bridge only. */
function userExtSource(): string {
  return `// Throwaway contract-check runtime extension (owned by extensions-check.ts).
const ui = (window as unknown as { __opencodeUI?: { register?: (ext: unknown) => void } }).__opencodeUI;
if (ui && typeof ui.register === "function") {
  ui.register({ kind: "contribute", id: "${USER_REG_ID}", collection: "palette", item: { title: "Contract check", run: () => {} } });
}
`;
}

// ---------------------------------------------------------------------------
// Child processes + browser session (module-scoped so `finally` sees them)
// ---------------------------------------------------------------------------

const cap = new Capture();
let devProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let chromeProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let cdp: Cdp | null = null;
/** Base URL of OUR proxy instance (set during setup). */
let MANIFEST_BASE = "";
let chromeProfileDir: string | null = null;
/** bootId captured at the end of phase A — phase B's no-reload comparator. */
let bootIdPhaseA: number | null = null;
/** True when we created ~/.config/opencode/webui-extensions/ ourselves. */
let userParentCreated = false;
const myPorts: number[] = [];

async function cleanup(): Promise<void> {
  cdp?.close();
  if (devProc) await killTree(devProc.pid, devProc).catch(() => undefined);
  if (chromeProc) await killTree(chromeProc.pid, chromeProc).catch(() => undefined);
  // Ports we picked can only be held by our own leftovers — sweep them.
  for (const port of myPorts) {
    for (const pid of listenersOn(port)) {
      signal(pid, "SIGTERM");
      await sleep(300);
      if (pidAlive(pid)) signal(pid, "SIGKILL");
    }
  }
  for (const dir of [EXT_DIR, USER_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[extensions-check] failed to remove ${dir}:`, err);
    }
  }
  if (userParentCreated) {
    try {
      rmSync(dirname(USER_DIR), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    if (chromeProfileDir) rmSync(chromeProfileDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseD(): Promise<void> {
  const t0 = Date.now();

  // The manifest is cookie-gated; without a session everything below would
  // 401 — degrade to a SKIP (never a false FAIL) if login didn't stick.
  if (authCookie === null) {
    rows.push({
      label: "D  user-dir runtime pipeline",
      status: "SKIP",
      detail: "no proxy session (login failed in setup) — server-side /api probes cannot run",
      secs: Date.now() - t0,
    });
    return;
  }

  // Drop the user-dir extension and wait for discovery. The manifest id is
  // the FOLDER name (server/userExtensions.ts); the bridge registration id
  // ("zz-user-check") only exists inside the bundle. Discovery is cached 5s
  // server-side, hence the generous poll.
  let entry: { id: string; source?: string; url: string } | null = null;
  try {
    if (!existsSync(dirname(USER_DIR))) userParentCreated = true;
    mkdirSync(USER_DIR, { recursive: true });
    writeFileSync(USER_FILE, userExtSource());
    const t1 = Date.now();
    while (Date.now() - t1 < 20_000 && entry === null) {
      const res = await apiFetch("/api/webui/extensions");
      if (res.status === 401) throw new Error("manifest returned 401 — proxy session did not stick");
      const body = (await res.json().catch(() => ({}))) as {
        data?: Array<{ id?: string; url?: string; source?: string }>;
      };
      const hit = (body.data ?? []).find(
        (e) => (e.id === EXT_ID || e.id === USER_REG_ID) && typeof e.url === "string",
      );
      if (hit && typeof hit.url === "string") {
        entry = { id: hit.id ?? "?", source: hit.source, url: hit.url };
      } else {
        await sleep(POLL_MS);
      }
    }
  } catch (err) {
    rows.push({
      label: "D  user-dir runtime pipeline",
      status: "FAIL",
      detail: `probe error: ${err instanceof Error ? err.message : String(err)}`,
      secs: Date.now() - t0,
    });
    return;
  }

  if (entry === null) {
    rows.push({
      label: "D  user-dir runtime pipeline",
      status: "SKIP",
      detail:
        `${USER_DIR} was not picked up by GET /api/webui/extensions within 20s — ` +
        "user-dir discovery (server/userExtensions.ts) appears unwired; upgrade this phase " +
        "only after confirming the scan is merged into discoverAllUIEntries()",
      secs: Date.now() - t0,
    });
    return;
  }

  // Full assertion: manifest entry shape + bundle serves the bridge code.
  try {
    const bundle = await apiFetch(entry.url);
    const js = await bundle.text();
    const bundleOk =
      bundle.status === 200 &&
      (bundle.headers.get("content-type") ?? "").includes("javascript") &&
      js.includes(USER_REG_ID);
    rows.push({
      label: "D  user-dir runtime pipeline",
      status: bundleOk ? "PASS" : "FAIL",
      detail: bundleOk
        ? `manifest lists id "${entry.id}" (source: ${entry.source ?? "?"}) → bundle ${js.length}b registers "${USER_REG_ID}" via window.__opencodeUI`
        : `bundle broken: HTTP ${bundle.status}, ${(bundle.headers.get("content-type") ?? "?").slice(0, 40)}, ${js.length}b`,
      secs: Date.now() - t0,
    });
  } catch (err) {
    rows.push({
      label: "D  user-dir runtime pipeline",
      status: "FAIL",
      detail: `bundle fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      secs: Date.now() - t0,
    });
    return;
  }

  // D-lite: manifest shape + unknown-id handling (counted, real surface).
  try {
    const res = await apiFetch("/api/webui/extensions");
    const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
    const shapeOk = res.status === 200 && Array.isArray(body.data);
    rows.push({
      label: "D1 manifest route shape",
      status: shapeOk ? "PASS" : "FAIL",
      detail: `GET /api/webui/extensions → ${res.status}, data: ${
        Array.isArray(body.data) ? `${body.data.length} runtime entr(ies)` : "not an array"
      }`,
      secs: Date.now() - t0,
    });
  } catch (err) {
    rows.push({
      label: "D1 manifest route shape",
      status: "FAIL",
      detail: String(err),
      secs: Date.now() - t0,
    });
  }

  try {
    const res = await apiFetch("/api/webui/extensions/zz-not-a-plugin/bundle.js");
    rows.push({
      label: "D2 unknown bundle id → 404",
      status: res.status === 404 ? "PASS" : "FAIL",
      detail: `HTTP ${res.status} (expected 404)`,
      secs: Date.now() - t0,
    });
  } catch (err) {
    rows.push({
      label: "D2 unknown bundle id → 404",
      status: "FAIL",
      detail: String(err),
      secs: Date.now() - t0,
    });
  }
}

async function main(): Promise<void> {
  mkdirSync(SCRATCH, { recursive: true });

  // Stale state from a crashed earlier run of this script.
  rmSync(EXT_DIR, { recursive: true, force: true });

  if (!existsSync(CHROME)) {
    rows.push({
      label: "A/B/C browser phases",
      status: "SKIP",
      detail: `chrome not found at ${CHROME}`,
    });
  }

  // --- Setup: ports, isolated dev instance (no gating edits exist — folder
  // presence IS installed, so nothing must land pre-launch). ---
  const t0 = Date.now();
  const vitePort = freePort();
  const proxyPort = freePort();
  const cdpPort = freePort();
  myPorts.push(vitePort, proxyPort, cdpPort);

  // Our instance, our password: honors a caller-provided WEBUI_PASSWORD,
  // otherwise mints one — so the script-side /api probes can always log in.
  const proxyPassword = process.env.WEBUI_PASSWORD || `extcheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  devProc = Bun.spawn({
    cmd: ["bun", "run", "scripts/dev.ts"],
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WEBUI_PASSWORD: proxyPassword,
      WEBUI_VITE_PORT: String(vitePort),
      WEBUI_PROXY_PORT: String(proxyPort),
      WEBUI_DEBUG_LOG: SERVER_LOG,
    },
  });
  void pump(devProc.stdout, cap, "out");
  void pump(devProc.stderr, cap, "err");

  // Prefer the ports the servers ACTUALLY took (vite drifts +1 if raced).
  // Banner formats: "[webui] ready → http://localhost:P" (auth-era proxy) or
  // the pre-auth "[webui] proxy listening on http://127.0.0.1:P".
  let viteActual = vitePort;
  let proxyActual = proxyPort;
  {
    const t1 = Date.now();
    while (Date.now() - t1 < 45_000) {
      const v = cap.all.match(/Local:\s+\S*:(\d+)/);
      const p =
        cap.all.match(/ready\s*(?:→|->)\s*\S*?:(\d+)/) ??
        cap.all.match(/proxy listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const vs = v?.[1];
      const ps = p?.[1];
      if (vs && ps) {
        viteActual = Number(vs);
        proxyActual = Number(ps);
        break;
      }
      await sleep(300);
    }
  }
  const appUrl = `http://127.0.0.1:${viteActual}`;
  MANIFEST_BASE = `http://127.0.0.1:${proxyActual}`;
  await waitHttp(`${appUrl}/`, 60_000, `vite dev server (${appUrl})`);
  // /api is cookie-gated (server/auth.ts) — log in as soon as the proxy is up.
  {
    const t1 = Date.now();
    let lastErr: unknown = null;
    while (Date.now() - t1 < 60_000) {
      try {
        await loginProxy(proxyPassword);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err; // usually "proxy not up yet" — keep retrying
        await sleep(400);
      }
    }
    if (lastErr !== null) {
      throw new Error(
        `proxy login never succeeded: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    }
  }
  await waitHttp(`${MANIFEST_BASE}/api/webui/extensions`, 30_000, `proxy (${MANIFEST_BASE})`, {
    headers: { cookie: authCookie ?? "" },
  });

  let browserReady = false;
  if (existsSync(CHROME)) {
    chromeProfileDir = join(SCRATCH, `extcheck-chrome-${process.pid}-${Date.now().toString(36)}`);
    chromeProc = Bun.spawn({
      cmd: [
        CHROME,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeProfileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,960",
        "about:blank",
      ],
      stdio: ["ignore", "pipe", "pipe"],
    });
    void pump(chromeProc.stdout, cap, "out");
    void pump(chromeProc.stderr, cap, "err");

    let wsUrl: string | null = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 20_000 && !wsUrl) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
          const list = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
          wsUrl = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
        }
      } catch {
        /* devtools endpoint not up yet */
      }
      if (!wsUrl) await sleep(300);
    }
    if (!wsUrl) throw new Error("chrome: no page target on the debug port");
    cdp = new Cdp(wsUrl);
    await cdp.open();
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Page.navigate", { url: appUrl });
    const BOOT_EXPR = `(() => { const r = document.getElementById("root"); return !!r && r.children.length > 0 && document.readyState === "complete"; })()`;
    const boot = await cdp.waitFor(BOOT_EXPR, "app boot");
    if (!boot.ok) throw new Error(`app did not boot in chrome (last: ${String(boot.last).slice(0, 200)})`);
    // Log the BROWSER in too (same-origin POST through the vite proxy sets
    // the session cookie) so the app runs in its normal authenticated state
    // and the page console stays clean for failure diagnostics. Non-fatal:
    // phases A–C exercise frontend plumbing that works unauthenticated.
    try {
      const status = await cdp.evaluate(
        `fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, ` +
          `body: JSON.stringify({ password: ${JSON.stringify(proxyPassword)} }) }).then((r) => r.status)`,
        true,
      );
      if (status !== 200) throw new Error(`HTTP ${String(status)}`);
      // Reload, but don't race it: plant a marker that only the OLD document
      // has, then wait for boot on a document where it is GONE.
      await cdp.evaluate(`window.__extCheckReloading = true`);
      await cdp.call("Page.reload", {});
      const boot2 = await cdp.waitFor(
        `(() => {
          const r = document.getElementById("root");
          return !window.__extCheckReloading && !!r && r.children.length > 0 && document.readyState === "complete";
        })()`,
        "app boot after login",
        20_000,
      );
      if (!boot2.ok) throw new Error(`app did not re-boot after login (${String(boot2.last).slice(0, 200)})`);
      const authed = await cdp.evaluate(`fetch("/api/webui/status").then((r) => r.status)`, true);
      if (authed !== 200) throw new Error(`session cookie not effective after reload (status probe: ${String(authed)})`);
    } catch (err) {
      console.error(
        "[extensions-check] browser login skipped (page stays unauthenticated — 401 console noise expected):",
        err instanceof Error ? err.message : err,
      );
    }
    browserReady = true;
    rows.push({ label: "SETUP isolated dev instance + headless chrome", status: "PASS", secs: Date.now() - t0 });
  } else {
    rows.push({ label: "SETUP isolated dev instance", status: "PASS", secs: Date.now() - t0 });
  }

  // A reload between setup and phase A would invalidate the sentinel — set it
  // only once the app is quiet, then never touch it again until phase C.
  let sentinel = "";
  if (cdp) {
    sentinel = `sentinel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const set = await cdp.evaluate(`window.__extCheckSentinel = ${JSON.stringify(sentinel)}; window.__extCheckSentinel`);
    if (set !== sentinel) throw new Error(`could not plant reload sentinel (got ${String(set)})`);
  }

  const abortBrowserPhases = (why: string) => {
    for (const label of ["A  hot add + register", "B  edit hot-swap (no reload)", "C  remove → pruned"]) {
      if (!rows.some((r) => r.label === label)) {
        rows.push({ label, status: "SKIP", detail: `not run: ${why}` });
      }
    }
  };

  // --- Phase A: hot ADD ---
  if (browserReady && cdp) {
    const t1 = Date.now();
    mkdirSync(EXT_DIR, { recursive: true });
    writeFileSync(EXT_FILE, extSource("v1"));
    const a = await cdp.waitFor(
      `(() => {
        const el = document.querySelector('[data-contract-check="v1"]');
        const c = window.__contractCheck;
        return !!(el && el.textContent === "CONTRACT_CHECK_V1" && c && c.registered === true && c.edits === 0
          && window.__extCheckSentinel === ${JSON.stringify(sentinel)});
      })()`,
      "phase A: marker v1 rendered + registered",
    );
    if (a.ok) {
      const bootId = await cdp.evaluate(
        `(() => { const c = window.__contractCheck; return c && typeof c.bootId === "number" ? c.bootId : null; })()`,
      );
      if (typeof bootId === "number") bootIdPhaseA = bootId;
      rows.push({
        label: "A  hot add + register",
        status: typeof bootId === "number" ? "PASS" : "FAIL",
        detail:
          typeof bootId === "number"
            ? `sidebar wrap renders CONTRACT_CHECK_V1 · registered · bootId captured — sentinel intact → zero reloads`
            : `bootId not a number: ${String(bootId)}`,
        secs: Date.now() - t1,
      });
      if (typeof bootId !== "number") abortBrowserPhases("phase A bootId capture failed");
    } else {
      const diag = await cdp.evaluate(
        `JSON.stringify({
          markerV1: !!document.querySelector('[data-contract-check="v1"]'),
          check: window.__contractCheck ?? null,
          sentinelOk: window.__extCheckSentinel === ${JSON.stringify(sentinel)},
          rootChildren: document.getElementById("root")?.children.length ?? -1,
        })`,
      );
      rows.push({
        label: "A  hot add + register",
        status: "FAIL",
        detail:
          `last: ${String(a.last).slice(0, 200)}\ndiag: ${String(diag).slice(0, 300)}\n` +
          `page console:\n${cdp.consoleTail(8)}\n` +
          `dev server tail:\n${cap.tail(800)}`,
        secs: Date.now() - t1,
      });
      abortBrowserPhases("phase A failed");
    }
  } else {
    abortBrowserPhases("no chrome");
  }

  // --- Phase B: hot EDIT (must NOT reload) ---
  if (rows.find((r) => r.label === "A  hot add + register")?.status === "PASS" && cdp) {
    const t1 = Date.now();
    writeFileSync(EXT_FILE, extSource("v2"));
    const b = await cdp.waitFor(
      `(() => {
        const el = document.querySelector('[data-contract-check="v2"]');
        const gone = !document.querySelector('[data-contract-check="v1"]');
        const c = window.__contractCheck;
        return !!(el && el.textContent === "CONTRACT_CHECK_V2" && gone && c && c.registered === true && c.edits === 1
          && window.__extCheckSentinel === ${JSON.stringify(sentinel)});
      })()`,
      "phase B: marker v2 swapped in, edits=1, no reload",
    );
    if (b.ok) {
      const bootId = await cdp.evaluate(
        `(() => { const c = window.__contractCheck; return c && typeof c.bootId === "number" ? c.bootId : null; })()`,
      );
      const same = typeof bootId === "number" && bootIdPhaseA !== null && bootId === bootIdPhaseA;
      rows.push({
        label: "B  edit hot-swap (no reload)",
        status: same ? "PASS" : "FAIL",
        detail: same
          ? `v2 swapped in, edits:1, bootId unchanged — same-id registry swap, zero reloads`
          : `bootId changed (${bootIdPhaseA} → ${String(bootId)}) — page reloaded during edit, hot-swap broken`,
        secs: Date.now() - t1,
      });
    } else {
      rows.push({
        label: "B  edit hot-swap (no reload)",
        status: "FAIL",
        detail:
          `last: ${String(b.last).slice(0, 300)}\n` +
          `page console:\n${cdp.consoleTail()}\n` +
          `dev server tail:\n${cap.tail(800)}`,
        secs: Date.now() - t1,
      });
    }
  }

  // --- Phase C: REMOVE (marker must vanish; cleanup arrives via the
  // loader's owned-set unregister at the HMR boundary — Vite accepts the
  // deletion at webui-extensions/index.ts, so the no-reload prune path is
  // the observed norm; a coalesced full reload would also satisfy the
  // removal contract and the report below names which one fired) ---
  if (rows.find((r) => r.label === "B  edit hot-swap (no reload)")?.status === "PASS" && cdp) {
    const t1 = Date.now();
    rmSync(EXT_DIR, { recursive: true, force: true });
    const gone = await cdp.waitFor(
      `(() => {
        const r = document.getElementById("root");
        const booted = !!r && r.children.length > 0 && document.readyState === "complete";
        return booted && !document.querySelector('[data-contract-check]');
      })()`,
      "phase C: marker gone after folder deletion",
    );
    if (!gone.ok) {
      const diag = await cdp.evaluate(
        `JSON.stringify({
          marker: !!document.querySelector('[data-contract-check]'),
          check: window.__contractCheck ?? null,
          sentinel: window.__extCheckSentinel ?? null,
          rootChildren: document.getElementById("root")?.children.length ?? -1,
        })`,
      );
      rows.push({
        label: "C  remove → pruned",
        status: "FAIL",
        detail: `after delete: ${String(diag).slice(0, 300)}\npage console:\n${cdp.consoleTail(8)}`,
        secs: Date.now() - t1,
      });
    } else {
      // Which cleanup mechanism fired? Reload ⇒ window state wiped (sentinel
      // + probe object gone); prune ⇒ window state intact. Allow a short
      // grace window for a late coalesced reload before settling on "prune".
      let path = (await cdp.evaluate(`window.__extCheckSentinel === undefined`)) === true ? "reload" : "prune";
      if (path === "prune") {
        await sleep(5_000);
        if ((await cdp.evaluate(`window.__extCheckSentinel === undefined`)) === true) path = "reload (late)";
      }
      const healthy = await cdp.waitFor(
        `(() => {
          const r = document.getElementById("root");
          return !!r && r.children.length > 0 && document.readyState === "complete"
            && !document.querySelector('[data-contract-check]');
        })()`,
        "phase C: final state healthy",
        10_000,
      );
      rows.push({
        label: "C  remove → pruned",
        status: healthy.ok ? "PASS" : "FAIL",
        detail: healthy.ok
          ? path === "prune"
            ? "folder deleted → registration pruned at the HMR boundary (NO reload; sentinel + app state intact)"
            : "folder deleted → coalesced full reload → marker gone, window state wiped"
          : `post-delete state unhealthy: ${String(healthy.last).slice(0, 200)}`,
        secs: Date.now() - t1,
      });
    }
  }

  // --- Phase D: runtime/user-dir pipeline (server side; no browser) ---
  await phaseD();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function report(): void {
  const width = Math.max(...rows.map((r) => r.label.length), 30);
  console.log("\n=== extension registry contract check ===");
  for (const r of rows) {
    const secs = r.secs !== undefined ? ` (${(r.secs / 1000).toFixed(1)}s)` : "";
    console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}${secs}`);
    if (r.detail) {
      for (const line of r.detail.split("\n")) console.log(`     ${line}`);
    }
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const skip = rows.filter((r) => r.status === "SKIP").length;
  console.log(`\nRESULT: ${pass} pass · ${fail} fail · ${skip} skip → exit ${fail > 0 ? 1 : 0}`);
  console.log(
    "Notes: gating is folder presence (no config list); phases A/B measure " +
      "the folder add/edit lifecycle reload-free, phase C the owned-set " +
      "unregister on folder delete.",
  );
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
      (cap.all.trim() ? `\ndev server tail:\n${cap.tail(1_500)}` : ""),
  });
  code = 1;
} finally {
  await cleanup();
  report();
}
// Brief pause so piped stdout flushes before a hard exit.
await sleep(50);
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : code);
