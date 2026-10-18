#!/usr/bin/env bun
/**
 * TESTKIT — an agent-facing, fully isolated OpenCode test harness.
 *
 *   import { start } from "./harness";
 *   const h = await start({ extensions: [FIXTURE] });
 *   try {
 *     // drive the system EXACTLY as a user would, through `h.ui` (real browser)
 *     // and `h.tui` (real terminal); `h.client` is an API cross-check, not proof.
 *   } finally {
 *     await h.stop();
 *   }
 *
 * What one call boots, and why each piece is isolated:
 *
 *   engine  — `opencode2 serve --service` with OWN XDG_CONFIG_HOME /
 *             XDG_STATE_HOME / XDG_DATA_HOME under a throwaway temp dir, OWN
 *             cwd, and a free port. It registers at
 *             `<state>/opencode/service.json`; the developer's live
 *             `~/.local/state/opencode/service.json` is never read or written.
 *             The service password is STABLE for a fixed STATE dir (verified),
 *             which is what lets a reinstall restart the engine without
 *             re-pointing the proxy.
 *   proxy   — this package's own server entry (`server/index.ts`) pointed at THAT engine via
 *             WEBUI_ENGINE_URL / WEBUI_ENGINE_PASSWORD, WEBUI_NO_SETUP=1,
 *             WEBUI_SANDBOX=1 (loopback, passwordless, no setup, never claims
 *             the shared pidfile), its own port, and an isolated
 *             WEBUI_EXTENSION_DIR scratch so an extension under test loads in
 *             isolation.
 *   ui      — the REAL webui page in a real Chromium (Playwright), when the
 *             environment has a browser; see ./ui.ts and ./browser.ts. The
 *             browser is OPTIONAL and never bundled — with none, `handle.ui`
 *             fails soft and `handle.browser.available` is false.
 *   tui     — the REAL `opencode` interactive client in a real tmux terminal;
 *             see ./tui.ts. Its rendered terminal buffer IS what the user sees.
 *   client  — a supplementary API wrapper over the SAME `/api/*` surface the
 *             browser uses. An API response is a CLAIM; prefer ui/tui evidence.
 *
 * SAFETY: this host has a documented engine fork-bomb history (see the header
 * of server/engineResolver.ts). Everything here uses isolated XDG dirs + free
 * ports, spawns only its own children, kills only its own pids on stop, and
 * removes its temp dirs. It never touches the running production webui/engine.
 *
 * Test-only module: writes nothing into src/ or server/.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTui, type TuiDriver } from "./tui";
import { createUi, type UiDriver } from "./ui";
import { resolveBrowser, type BrowserPlan } from "./browser";

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/**
 * Repo OR package root — resolved from this file (`<root>/scripts/testkit/`), so
 * it is correct from a repo checkout and from an installed npm package alike.
 * Everything below reaches its files through ROOT, never through the cwd.
 */
export const ROOT = resolve(import.meta.dir, "..", "..");
/** The proxy entry this harness spawns — the same server the CLI launches. */
export const SERVER_ENTRY = join(ROOT, "server", "index.ts");
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A free loopback port — ours by definition (bind-then-release). */
export function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = s.port;
  s.stop(true);
  if (typeof port !== "number" || port <= 0) throw new Error("[testkit] could not obtain a free port");
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

/** SIGTERM then SIGKILL a pid we own; never throws. */
async function killPid(pid: number, graceMs = 5_000): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pidAlive(pid)) await sleep(150);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Wait until a loopback port can be bound again (previous owner gone). */
async function waitPortFree(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      s.stop(true);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`[testkit] port ${port} never freed`);
      await sleep(150);
    }
  }
}

/** The v2 engine binary (NOT the PATH 1.x `opencode`). */
export function engineBin(): string {
  const override = process.env.OPENCODE_ENGINE_BIN;
  if (override && override.length > 0) return override;
  const found = Bun.spawnSync(["which", "opencode2"]);
  if (found.exitCode === 0) {
    const p = found.stdout.toString().trim().split("\n")[0]?.trim();
    if (p) return p;
  }
  throw new Error("[testkit] no v2 engine binary: set OPENCODE_ENGINE_BIN or put `opencode2` on PATH");
}

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) if (existsSync(p)) return p;
  return undefined;
}

// ---------------------------------------------------------------------------
// assertions + reporting (legible diffs, PASS/FAIL/SKIP rows)
// ---------------------------------------------------------------------------

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

function show(v: unknown): string {
  try {
    return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

class Expectation<T> {
  constructor(private readonly actual: T, private readonly label: string) {}

  private fail(msg: string): never {
    throw new AssertionError(`${this.label ? `${this.label}: ` : ""}${msg}`);
  }

  toBe(expected: T): void {
    if (this.actual !== expected) this.fail(`expected ${show(expected)}, got ${show(this.actual)}`);
  }
  toEqual(expected: T): void {
    const a = JSON.stringify(this.actual);
    const e = JSON.stringify(expected);
    if (a !== e) this.fail(`expected deep-equal to ${e}, got ${a}`);
  }
  toContain(sub: string): void {
    const s = typeof this.actual === "string" ? this.actual : JSON.stringify(this.actual);
    if (!s.includes(sub)) this.fail(`expected to contain ${show(sub)}; actual (${s.length} chars): ${s.slice(0, 400)}`);
  }
  toMatch(re: RegExp): void {
    if (!re.test(String(this.actual))) this.fail(`expected to match ${re}; got ${show(this.actual)}`);
  }
  toBeTruthy(): void {
    if (!this.actual) this.fail(`expected truthy, got ${show(this.actual)}`);
  }
  toBeGreaterThan(n: number): void {
    if (typeof this.actual !== "number" || !(this.actual > n)) this.fail(`expected > ${n}, got ${show(this.actual)}`);
  }
}

export function expect<T>(actual: T, label = "expect"): Expectation<T> {
  return new Expectation(actual, label);
}

export function assert(cond: unknown, label: string, detail?: string): asserts cond {
  if (!cond) throw new AssertionError(`${label}${detail ? ` — ${detail}` : ""}`);
}

export interface Row {
  label: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
  secs?: number;
}

/** Minimal PASS/FAIL/SKIP reporter — the batteries' row style, importable. */
export class Reporter {
  readonly rows: Row[] = [];
  private readonly onFail: (() => Promise<void> | void)[] = [];

  /** Run one check; a thrown error (usually AssertionError) fails it. */
  async check(label: string, fn: () => Promise<void> | void): Promise<void> {
    const t0 = Date.now();
    try {
      await fn();
      this.rows.push({ label, status: "PASS", secs: Date.now() - t0 });
    } catch (err) {
      const detail = err instanceof Error ? (err.message || err.stack || String(err)) : String(err);
      this.rows.push({ label, status: "FAIL", detail: detail.slice(0, 2_000), secs: Date.now() - t0 });
      for (const f of this.onFail) await f();
    }
  }

  /** Record an explicit skip (model-dependent steps, missing prerequisites). */
  skip(label: string, reason: string): void {
    this.rows.push({ label, status: "SKIP", detail: reason });
  }

  /** Register a failure hook (e.g. dump artifacts). Runs on each FAIL. */
  onFailure(fn: () => Promise<void> | void): void {
    this.onFail.push(fn);
  }

  get failed(): boolean {
    return this.rows.some((r) => r.status === "FAIL");
  }

  print(title = "testkit"): number {
    const width = Math.max(...this.rows.map((r) => r.label.length), 20);
    console.log(`\n=== ${title} ===`);
    for (const r of this.rows) {
      const secs = r.secs !== undefined ? ` (${(r.secs / 1000).toFixed(1)}s)` : "";
      console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}${secs}`);
      if (r.detail) for (const line of r.detail.split("\n")) console.log(`     ${line}`);
    }
    const pass = this.rows.filter((r) => r.status === "PASS").length;
    const fail = this.rows.filter((r) => r.status === "FAIL").length;
    const skip = this.rows.filter((r) => r.status === "SKIP").length;
    console.log(`\nRESULT: ${pass} pass · ${fail} fail · ${skip} skip → exit ${fail > 0 ? 1 : 0}`);
    return fail > 0 ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// generic wait
// ---------------------------------------------------------------------------

export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/**
 * Poll `fn` until it returns a truthy value; resolve with it. On timeout throw
 * a legible error carrying the last observed value and the label.
 */
export async function waitFor<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  opts: WaitOpts = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 200;
  const label = opts.label ?? "waitFor";
  const t0 = Date.now();
  let last: unknown = "not evaluated";
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = v;
    } catch (err) {
      last = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (Date.now() - t0 >= timeoutMs) {
      throw new AssertionError(`${label}: not satisfied within ${timeoutMs}ms (last: ${show(last)})`);
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// events — a buffered /api/event SSE reader
// ---------------------------------------------------------------------------

export interface EngineEvent {
  id?: string;
  type: string;
  data?: unknown;
  created?: number;
}

/**
 * One buffered subscription to the proxy's `/api/event` fan-out. Keeps every
 * frame it has seen, lets you `waitFor` a matching event (including ones that
 * already arrived), and reconnects if the stream drops.
 */
export class EventLog {
  private readonly events: EngineEvent[] = [];
  private waiters: Array<{ pred: (e: EngineEvent) => boolean; resolve: (e: EngineEvent) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private ac = new AbortController();
  private stopped = false;

  constructor(private readonly url: string) {}

  start(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(this.url, { signal: this.ac.signal, headers: { accept: "text/event-stream" } });
        if (!res.body) throw new Error(`no body (HTTP ${res.status})`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trimEnd();
            buf = buf.slice(idx + 1);
            if (line.startsWith("data:")) this.push(line.slice(5).trim());
          }
        }
      } catch {
        /* aborted or dropped — reconnect below */
      }
      if (this.stopped) break;
      await sleep(400);
    }
  }

  private push(raw: string): void {
    if (!raw) return;
    let evt: EngineEvent;
    try {
      const parsed = JSON.parse(raw) as EngineEvent;
      if (!parsed || typeof parsed.type !== "string") return;
      evt = parsed;
    } catch {
      return;
    }
    this.events.push(evt);
    if (this.events.length > 5_000) this.events.splice(0, this.events.length - 5_000);
    this.waiters = this.waiters.filter((w) => {
      if (w.pred(evt)) {
        clearTimeout(w.timer);
        w.resolve(evt);
        return false;
      }
      return true;
    });
  }

  all(): EngineEvent[] {
    return [...this.events];
  }

  /** Events matching a type string or regex. */
  ofType(type: string | RegExp): EngineEvent[] {
    const match = typeof type === "string" ? (t: string) => t === type : (t: string) => type.test(t);
    return this.events.filter((e) => match(e.type));
  }

  /** Wait for the first event (past or future) matching `pred`. */
  waitFor(pred: (e: EngineEvent) => boolean, opts: WaitOpts = {}): Promise<EngineEvent> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise<EngineEvent>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        rejectP(new AssertionError(`${opts.label ?? "waitForEvent"}: no matching event within ${timeoutMs}ms (seen ${this.events.length}, tail: ${this.events.slice(-5).map((e) => e.type).join(", ") || "none"})`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolveP, reject: rejectP, timer });
    });
  }

  waitForType(type: string | RegExp, opts: WaitOpts = {}): Promise<EngineEvent> {
    const match = typeof type === "string" ? (t: string) => t === type : (t: string) => type.test(t);
    return this.waitFor((e) => match(e.type), { label: `waitForEvent(${String(type)})`, ...opts });
  }

  stop(): void {
    this.stopped = true;
    this.ac.abort();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new AssertionError("event log stopped"));
    }
    this.waiters = [];
  }
}

// ---------------------------------------------------------------------------
// the supplementary API client (typed wrapper over the /api/* surface)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export class UserClient {
  readonly events: EventLog;

  constructor(readonly baseUrl: string) {
    this.events = new EventLog(`${baseUrl}/api/event`);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, init);
  }

  async json<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const msg = (body && typeof body === "object" && "message" in (body as Json) ? String((body as Json).message) : text) || res.statusText;
      throw new ApiError(`${init.method ?? "GET"} ${path} → ${res.status}: ${msg.slice(0, 300)}`, res.status);
    }
    return body as T;
  }

  private post<T = Json>(path: string, body?: unknown): Promise<T> {
    return this.json<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // ---- sessions ----------------------------------------------------------

  async createSession(body: Json = {}): Promise<Json> {
    const full = { title: null, agent: null, model: null, location: null, ...body };
    const res = await this.post<{ data: Json }>("/api/session", full);
    return res.data;
  }

  async getSession(id: string): Promise<Json> {
    return (await this.json<{ data: Json }>(`/api/session/${id}`)).data;
  }

  async listSessions(limit = 50): Promise<Json[]> {
    const res = await this.json<{ data: Json[] }>(`/api/session?limit=${limit}&order=desc`);
    return res.data ?? [];
  }

  async deleteSession(id: string): Promise<void> {
    await this.json(`/api/session/${id}`, { method: "DELETE" });
  }

  async activeSessions(): Promise<Record<string, { type: string }>> {
    return (await this.json<{ data: Record<string, { type: string }> }>("/api/session/active")).data ?? {};
  }

  // ---- messaging ---------------------------------------------------------

  /** Admit a prompt (steer joins the active run; queue waits). Returns the inbox item. */
  async prompt(sessionID: string, text: string, delivery?: "steer" | "queue"): Promise<Json> {
    const res = await this.post<{ data: Json }>(`/api/session/${sessionID}/prompt`, delivery ? { text, delivery } : { text });
    return res.data;
  }

  async inbox(sessionID: string): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>(`/api/session/${sessionID}/inbox`)).data ?? [];
  }

  async interrupt(sessionID: string): Promise<Json> {
    return this.json<Json>(`/api/session/${sessionID}/interrupt`, { method: "POST" });
  }

  async messages(sessionID: string, opts: { limit?: number; type?: string } = {}): Promise<Json[]> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100), order: "desc" });
    if (opts.type) params.set("type", opts.type);
    const res = await this.json<{ data: Json[] }>(`/api/session/${sessionID}/message?${params}`);
    return res.data ?? [];
  }

  /** Flatten messages → a plain transcript string (text parts only). */
  async transcript(sessionID: string): Promise<string> {
    const msgs = await this.messages(sessionID);
    const parts: string[] = [];
    for (const m of [...msgs].reverse()) {
      const content = (m as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const t = (c as { text?: unknown }).text;
          if (typeof t === "string") parts.push(t);
        }
      }
    }
    return parts.join("\n");
  }

  /**
   * Wait until a session goes idle. `requireRunning` first waits for it to be
   * observed running (model-dependent turns only), so a no-op prompt cannot
   * make this resolve instantly on a system that never ran anything.
   */
  async waitIdle(sessionID: string, opts: WaitOpts & { requireRunning?: boolean; requireIdleReads?: number } = {}): Promise<void> {
    const requireRunning = opts.requireRunning ?? false;
    const requireIdleReads = opts.requireIdleReads ?? 2;
    if (requireRunning) {
      await waitFor(async () => (await this.activeSessions())[sessionID] !== undefined, {
        timeoutMs: opts.timeoutMs ?? 60_000,
        intervalMs: 250,
        label: `${opts.label ?? "waitIdle"}: session never became active`,
      });
    }
    let idle = 0;
    await waitFor(async () => {
      const active = await this.activeSessions();
      if (active[sessionID] === undefined) {
        idle += 1;
        return idle >= requireIdleReads;
      }
      idle = 0;
      return false;
    }, { timeoutMs: opts.timeoutMs ?? 120_000, intervalMs: 300, label: opts.label ?? "waitIdle" });
  }

  // ---- permissions -------------------------------------------------------

  async permissions(): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>("/api/permission/request")).data ?? [];
  }
  async sessionPermissions(id: string): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>(`/api/session/${id}/permission`)).data ?? [];
  }
  async replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject"): Promise<void> {
    // field name drifts across engine generations (decision | reply) — try both.
    try {
      await this.post(`/api/session/${sessionID}/permission/${requestID}/reply`, { decision: reply, message: null });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
        await this.post(`/api/session/${sessionID}/permission/${requestID}/reply`, { reply, message: null });
        return;
      }
      throw err;
    }
  }

  // ---- forms / questions -------------------------------------------------

  async forms(): Promise<Json[]> {
    try {
      return (await this.json<{ data: Json[] }>("/api/form")).data ?? [];
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
        return (await this.json<{ data: Json[] }>("/api/form/request")).data ?? [];
      }
      throw err;
    }
  }
  async sessionForms(id: string): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>(`/api/session/${id}/form`)).data ?? [];
  }
  async replyForm(sessionID: string, formID: string, answer: Record<string, unknown>): Promise<void> {
    await this.post(`/api/session/${sessionID}/form/${formID}/reply`, { answer });
  }
  async questions(): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>("/api/question/request")).data ?? [];
  }
  async sessionQuestions(id: string): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>(`/api/session/${id}/question`)).data ?? [];
  }
  async answerQuestion(sessionID: string, requestID: string, answers: unknown[]): Promise<void> {
    await this.post(`/api/session/${sessionID}/question/${requestID}/reply`, { answers });
  }

  // ---- proxy extension surface ------------------------------------------

  /** Raw call to a proxy-stratum extension route: `/api/webui/ext/<id>/<path>`. */
  ext(id: string, path: string, init?: RequestInit): Promise<Response> {
    const clean = path.replace(/^\/+/, "");
    return this.request(`/api/webui/ext/${encodeURIComponent(id)}/${clean}`, init);
  }

  async extJSON<T = Json>(id: string, path: string, init?: RequestInit): Promise<T> {
    const res = await this.ext(id, path, init);
    const text = await res.text();
    if (!res.ok) throw new ApiError(`ext ${id}/${path} → ${res.status}: ${text.slice(0, 200)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async extPost<T = Json>(id: string, path: string, body: unknown): Promise<T> {
    return this.extJSON<T>(id, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ---- proxy/core reads --------------------------------------------------

  async extensionManifest(): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>("/api/webui/extensions")).data ?? [];
  }

  async plugins(): Promise<Json[]> {
    return (await this.json<{ data: Json[] }>("/api/plugin")).data ?? [];
  }

  ready(): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>("/api/webui/status");
  }
}

// ---------------------------------------------------------------------------
// options / handle types
// ---------------------------------------------------------------------------

export interface TestkitPaths {
  root: string;
  config: string;
  state: string;
  data: string;
  cwd: string;
  extensions: string;
  artifacts: string;
}

export interface TestkitOptions {
  /** Extension folders to install once booted (via `handle.install`). */
  extensions?: string[];
  /** Scratch root (default: mkdtemp under the env scratch dir or the OS tmp). */
  root?: string;
  /**
   * Where screenshots/logs/rendered buffers are written. Defaults to a
   * persistent dir OUTSIDE the scratch root, so `stop()` can clean temp dirs
   * and still leave the evidence behind.
   */
  artifactsDir?: string;
  /** Keep the scratch dir + children logs after stop (debugging). */
  keep?: boolean;
  /** Copy the developer's provider credentials into the isolated engine (model-dependent tests). */
  providerCreds?: boolean;
  /** Default model for the isolated engine (e.g. "provider/model"); enables a real turn when a provider is discoverable. */
  model?: string;
  /** Extra env for the proxy. */
  env?: Record<string, string>;
  /** Engine binary override (default: OPENCODE_ENGINE_BIN or `opencode2`). */
  engineBin?: string;
  /** Explicit browser executable (TESTKIT_CHROME also works); resolved by ./browser. */
  chrome?: string;
  /** Verbose harness logging. */
  verbose?: boolean;
  timeouts?: { engineMs?: number; proxyMs?: number; extMs?: number };
}

export interface EngineInfo {
  url: string;
  password: string;
  pid: number;
  port: number;
  bin: string;
}

export interface ProxyInfo {
  url: string;
  port: number;
  pid: number;
}

export interface TestkitHandle {
  engine: EngineInfo;
  proxy: ProxyInfo;
  /** Supplementary API client — a CLAIM surface. Prefer `ui`/`tui` for evidence. */
  client: UserClient;
  /** The browser resolution (see ./browser). `available:false` ⇒ browser checks skip. */
  browser: BrowserPlan;
  /** The real webui page in a real browser (evidence), when one is available. */
  ui: UiDriver;
  /** The real opencode interactive client in a real terminal (evidence). */
  tui: TuiDriver;
  paths: TestkitPaths;
  /** The env the proxy was started with (isolation-relevant keys preserved). */
  env: Record<string, string>;
  /** True when provider creds were copied in (model steps are runnable). */
  providerCreds: boolean;
  /** Install an extension folder and wait until every stratum is live. */
  install(extDir: string): Promise<{ id: string }>;
  /** Restart the isolated engine (same dirs/port/password). */
  restartEngine(): Promise<void>;
  /** Poll a predicate (see waitFor). */
  waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, opts?: WaitOpts): Promise<T>;
  /** Write logs + screenshots + rendered buffers to the artifacts dir. */
  dumpArtifacts(): Promise<{ dir: string; files: string[] }>;
  engineLog(): string;
  proxyLog(): string;
  /** Idempotent teardown: kill every child, remove temp dirs (keep artifacts). */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUTS = { engineMs: 60_000, proxyMs: 40_000, extMs: 40_000 };

function scratchBase(): string {
  const fromEnv = process.env.TESTKIT_SCRATCH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Prefer the environment's approved scratch root when it exists (derived from
  // HOME, never a hard-coded absolute path — this file ships in the tarball).
  const approved = join(homedir(), ".hermes", "cache", "scratch", "opencode");
  return existsSync(approved) ? approved : join(homedir(), ".cache", "opencode-testkit");
}

function freshPaths(root: string, artifactsOverride?: string): TestkitPaths {
  const paths: TestkitPaths = {
    root,
    config: join(root, "config"),
    state: join(root, "state"),
    data: join(root, "data"),
    cwd: join(root, "cwd"),
    extensions: join(root, "extensions"),
    artifacts: artifactsOverride ?? join(root, "artifacts"),
  };
  for (const d of [join(paths.config, "opencode"), join(paths.state, "opencode"), paths.data, paths.cwd, paths.extensions, paths.artifacts]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  return paths;
}

function pump(stream: ReadableStream<Uint8Array> | null, sink: (chunk: string) => void): void {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) sink(dec.decode(value, { stream: true }));
      }
    } catch {
      /* torn down with the child */
    }
  })();
}

interface ServiceInfo {
  url: string;
  password: string;
  pid: number;
}

async function waitServiceFile(path: string, timeoutMs: number, label: string): Promise<ServiceInfo> {
  return waitFor(
    () => {
      try {
        const info = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown; password?: unknown; pid?: unknown };
        if (typeof info.url === "string" && info.url.length > 0 && typeof info.pid === "number") {
          return { url: info.url.replace(/\/+$/, ""), password: typeof info.password === "string" ? info.password : "", pid: info.pid };
        }
      } catch {
        /* not written yet */
      }
      return undefined;
    },
    { timeoutMs, intervalMs: 300, label },
  );
}

function readConfigPluginList(configFile: string): string[] {
  try {
    const cfg = JSON.parse(readFileSync(configFile, "utf8")) as { plugin?: unknown };
    if (Array.isArray(cfg.plugin)) return cfg.plugin.filter((p): p is string => typeof p === "string");
  } catch {
    /* fresh config */
  }
  return [];
}

function writeConfig(configFile: string, pluginPaths: string[], model?: string): void {
  const cfg: Record<string, unknown> = { $schema: "https://opencode.ai/config.json", plugin: pluginPaths };
  if (model) cfg.model = model;
  writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}

/** Resolve an engine plugin's declared id without running its setup(). */
async function enginePluginId(entry: string): Promise<string | undefined> {
  try {
    const mtime = statSync(entry).mtimeMs;
    const imported = (await import(`${pathToFileURL(entry).href}?v=${mtime}`)) as { default?: { id?: unknown }; id?: unknown };
    const mod = imported.default ?? imported;
    const id = (mod as { id?: unknown })?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

export async function start(opts: TestkitOptions = {}): Promise<TestkitHandle> {
  const verbose = opts.verbose ?? process.env.TESTKIT_VERBOSE === "1";
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
  const log = (msg: string): void => {
    if (verbose) console.log(`[testkit] ${msg}`);
  };

  const root = opts.root ?? join(scratchBase(), `tk-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Evidence survives `stop()`: default the artifacts dir OUTSIDE the scratch
  // root, so temp dirs are still removed while screenshots/logs remain.
  const artifactsDir = opts.artifactsDir ?? join(scratchBase(), "testkit-artifacts", basename(root));
  const paths = freshPaths(root, artifactsDir);

  // --- provider creds (opt-in) --------------------------------------------
  const wantCreds = opts.providerCreds ?? process.env.TESTKIT_PROVIDER_CREDS === "1";
  let providerCreds = false;
  if (wantCreds) {
    const realData = process.env.XDG_DATA_HOME_REAL ?? join(homedir(), ".local", "share");
    const src = join(realData, "opencode", "auth.json");
    if (existsSync(src)) {
      mkdirSync(join(paths.data, "opencode"), { recursive: true, mode: 0o700 });
      cpSync(src, join(paths.data, "opencode", "auth.json"));
      providerCreds = true;
      log(`provider creds copied into isolated data home`);
    } else {
      log(`providerCreds requested but ${src} is absent — model steps will be skipped`);
    }
  }

  // --- engine config -------------------------------------------------------
  const configFile = join(paths.config, "opencode", "opencode.jsonc");
  writeConfig(configFile, [], opts.model);

  let engineLog = "";
  let proxyLog = "";
  const engineEnvBase: Record<string, string> = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    XDG_DATA_HOME: paths.data,
  };
  // Never let a stray WEBUI_* leak into the engine environment.
  for (const k of Object.keys(engineEnvBase)) if (k.startsWith("WEBUI_")) delete engineEnvBase[k];

  let engineProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let proxyProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  const bin = opts.engineBin ?? engineBin();
  const enginePort = freePort();
  let proxyPort = freePort();
  for (let i = 0; proxyPort === enginePort && i < 8; i++) proxyPort = freePort();
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const proxyEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    WEBUI_PROXY_PORT: String(proxyPort),
    WEBUI_HOST: "127.0.0.1",
    WEBUI_SANDBOX: "1",
    WEBUI_NO_SETUP: "1",
    WEBUI_EXTENSION_DIR: paths.extensions,
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    XDG_DATA_HOME: paths.data,
    ...(opts.env ?? {}),
  };
  delete proxyEnv.NODE_ENV; // a prod flag would make the dev proxy claim the shared pidfile
  delete proxyEnv.WEBUI_PASSWORD;

  let stopped = false;

  const spawnEngine = async (port: number): Promise<ServiceInfo> => {
    const serviceFile = join(paths.state, "opencode", "service.json");
    rmSync(serviceFile, { force: true });
    const proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--service"], {
      cwd: paths.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: engineEnvBase,
    });
    engineProc = proc;
    pump(proc.stdout, (c) => (engineLog += c));
    pump(proc.stderr, (c) => (engineLog += c));
    const svc = await waitServiceFile(serviceFile, timeouts.engineMs, `engine service.json (pid ${proc.pid})`);
    if (svc.pid !== proc.pid) log(`engine registration pid ${svc.pid} != spawn pid ${proc.pid}`);
    return svc;
  };

  let service: ServiceInfo;
  const bootFail = async (err: unknown): Promise<never> => {
    // A failed boot must not leak a spawned child or hang the caller: kill our
    // own pids (which also ends the pump() readers) and remove the scratch dir.
    if (proxyProc?.pid) await killPid(proxyProc.pid);
    if (engineProc?.pid) await killPid(engineProc.pid);
    if (!opts.keep && process.env.TESTKIT_KEEP !== "1") rmSync(paths.root, { recursive: true, force: true });
    throw err instanceof Error ? err : new Error(String(err));
  };
  try {
    service = await spawnEngine(enginePort);
  } catch (err) {
    return bootFail(new Error(`[testkit] engine failed to boot: ${err instanceof Error ? err.message : String(err)}\nengine log tail:\n${engineLog.slice(-1_500)}`));
  }

  // The proxy needs the engine password BEFORE spawn (WEBUI_ENGINE_PASSWORD).
  proxyEnv.WEBUI_ENGINE_URL = service.url;
  proxyEnv.WEBUI_ENGINE_PASSWORD = service.password;

  proxyProc = Bun.spawn(["bun", "run", SERVER_ENTRY], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: proxyEnv,
  });
  pump(proxyProc.stdout, (c) => (proxyLog += c));
  pump(proxyProc.stderr, (c) => (proxyLog += c));

  const client = new UserClient(proxyUrl);
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`${proxyUrl}/api/webui/status`, { signal: AbortSignal.timeout(2_000) });
        return res.ok;
      } catch {
        return false;
      }
    }, { timeoutMs: timeouts.proxyMs, intervalMs: 300, label: "proxy boot (/api/webui/status)" });
  } catch (err) {
    return bootFail(new Error(`${err instanceof Error ? err.message : String(err)}\nproxy log tail:\n${proxyLog.slice(-1_500)}`));
  }

  // Resolve the browser ONCE (optional, never bundled). Both drivers share it;
  // with none, `ui.*` fails soft and callers skip their browser checks.
  const browser = await resolveBrowser({ chrome: opts.chrome });
  log(
    browser.available
      ? `browser: ${browser.source} (${browser.executablePath ?? "driver default"})`
      : `no browser: ${browser.reason} — browser checks will skip`,
  );

  const ui = createUi({ root: ROOT, proxyPort, artifactsDir: paths.artifacts, browser, log });
  const tui = createTui({
    root: paths.cwd,
    env: {
      XDG_CONFIG_HOME: paths.config,
      XDG_STATE_HOME: paths.state,
      XDG_DATA_HOME: paths.data,
      HOME: paths.root,
      TERM: "xterm-256color",
    },
    artifactsDir: paths.artifacts,
    browser,
    log,
  });

  const handle: TestkitHandle = {
    engine: { url: service.url, password: service.password, pid: service.pid, port: enginePort, bin },
    proxy: { url: proxyUrl, port: proxyPort, pid: proxyProc.pid },
    client,
    browser,
    ui,
    tui,
    paths,
    env: {
      WEBUI_ENGINE_URL: service.url,
      WEBUI_PROXY_PORT: String(proxyPort),
      WEBUI_EXTENSION_DIR: paths.extensions,
      XDG_STATE_HOME: paths.state,
      XDG_CONFIG_HOME: paths.config,
      XDG_DATA_HOME: paths.data,
    },
    providerCreds,

    waitFor,

    engineLog: () => engineLog,
    proxyLog: () => proxyLog,

    async restartEngine(): Promise<void> {
      const oldPid = engineProc?.pid;
      if (oldPid) await killPid(oldPid);
      await waitPortFree(enginePort);
      const svc = await spawnEngine(enginePort);
      handle.engine.url = svc.url;
      handle.engine.password = svc.password;
      handle.engine.pid = svc.pid;
      // The proxy holds the pinned credentials; a stable password means no
      // re-point is needed, but re-assert in case the engine ever rotates it.
      proxyEnv.WEBUI_ENGINE_PASSWORD = svc.password;
    },

    async install(extDir: string): Promise<{ id: string }> {
      const source = resolve(extDir);
      if (!existsSync(source)) throw new AssertionError(`install: extension folder not found: ${source}`);
      const name = basename(source);
      const dest = join(paths.extensions, name);
      // NOTE: the extension FOLDER NAME must equal the manifest `id` (core's
      // server-extension loader keys `loaded` by manifest id but its removal
      // scan by folder name; a mismatch reloads the module every poll). The
      // fixture ships the folder as `testkit-echo` matching its id.
      rmSync(dest, { recursive: true, force: true });
      cpSync(source, dest, { recursive: true });
      log(`installed ${name} → ${dest}`);

      let manifest: { id?: unknown } = {};
      try {
        manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")) as { id?: unknown };
      } catch {
        throw new AssertionError(`install(${name}): manifest.json missing or unreadable in ${source}`);
      }
      const id = typeof manifest.id === "string" && manifest.id.length > 0 ? manifest.id : name;

      const hasBrowserEntry = Boolean(firstExisting([join(dest, "index.tsx"), join(dest, "index.ts"), join(dest, "main.tsx"), join(dest, "main.ts")]));
      const hasDomEntry = existsSync(join(dest, "dom.ts"));
      const hasServerEntry = existsSync(join(dest, "server.ts"));
      const engineEntry = firstExisting([join(dest, "engine", "index.js"), join(dest, "engine", "index.cjs"), join(dest, "engine", "index.mjs")]);

      // --- browser + DOM strata: wait until the proxy's manifest lists them.
      await waitFor(async () => {
        const data = await client.extensionManifest();
        const entry = data.find((e) => e.id === id) as { url?: string; domUrl?: string; disabled?: boolean } | undefined;
        if (!entry || entry.disabled) return false;
        if (hasBrowserEntry && typeof entry.url !== "string") return false;
        if (hasDomEntry && typeof entry.domUrl !== "string") return false;
        return true;
      }, {
        timeoutMs: timeouts.extMs,
        intervalMs: 400,
        label: `install(${id}): manifest/bundle never went live`,
      }).catch(() => {
        throw new AssertionError(`install(${id}): proxy manifest never listed the extension with its bundle(s)\nproxy log tail:\n${proxyLog.slice(-1_200)}`);
      });

      // Fetch the bundle once, so a Bun.build failure surfaces as a clear error.
      if (hasBrowserEntry) {
        const res = await fetch(`${proxyUrl}/api/webui/extensions/${encodeURIComponent(id)}/bundle.js`);
        if (!res.ok) {
          throw new AssertionError(`install(${id}): browser bundle served HTTP ${res.status}\nproxy log tail:\n${proxyLog.slice(-1_200)}`);
        }
      }

      // --- proxy stratum: wait for the loader to report the module live.
      if (hasServerEntry) {
        await waitFor(() => proxyLog.includes(`server extension loaded: ${id}`), {
          timeoutMs: timeouts.extMs,
          intervalMs: 300,
          label: `install(${id}): server.ts never loaded`,
        }).catch(() => {
          const failed = proxyLog.includes(`server extension "${id}" failed`);
          throw new AssertionError(
            `install(${id}): proxy server.ts did not load${failed ? " (loader reported a failure)" : ""}\nproxy log tail:\n${proxyLog.slice(-1_500)}`,
          );
        });
      }

      // --- engine stratum: add the payload to the isolated config + restart.
      if (engineEntry) {
        const engineId = (await enginePluginId(engineEntry)) ?? id;
        const pluginPath = join(dest, "engine");
        const list = readConfigPluginList(configFile);
        if (!list.includes(pluginPath)) {
          list.push(pluginPath);
          writeConfig(configFile, list, opts.model);
        }
        await handle.restartEngine();
        await waitFor(async () => {
          const plugins = await client.plugins().catch(() => []);
          const hit = plugins.find((p) => (p as { id?: string }).id === engineId);
          const state = (hit as { state?: { status?: string } } | undefined)?.state?.status;
          return hit && state === "active" ? true : false;
        }, {
          timeoutMs: timeouts.extMs,
          intervalMs: 500,
          label: `install(${id}): engine plugin "${engineId}" never became active`,
        }).catch(() => {
          throw new AssertionError(`install(${id}): engine payload "${engineId}" not active\nengine log tail:\n${engineLog.slice(-1_500)}`);
        });
      }

      return { id };
    },

    async dumpArtifacts(): Promise<{ dir: string; files: string[] }> {
      const files: string[] = [];
      const write = async (name: string, content: string): Promise<void> => {
        const p = join(paths.artifacts, name);
        await Bun.write(p, content);
        files.push(p);
      };
      await write("engine.log", engineLog);
      await write("proxy.log", proxyLog);
      await write("events.jsonl", client.events.all().map((e) => JSON.stringify(e)).join("\n"));
      // Real-client evidence: the rendered terminal buffer (what the user sees).
      if (tui.started) {
        try {
          const scr = await tui.saveScreen("tui-screen.txt");
          files.push(scr);
        } catch (err) {
          log(`tui screen capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await write("meta.json", JSON.stringify({
        engine: { ...handle.engine, password: "<redacted>" },
        proxy: handle.proxy,
        paths,
        providerCreds,
      }, null, 2));
      if (ui.started) {
        try {
          const shot = await ui.screenshot(join(paths.artifacts, "screenshot.png"));
          files.push(shot);
        } catch (err) {
          log(`screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { dir: paths.artifacts, files };
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await ui.close();
      } catch {
        /* best-effort */
      }
      try {
        await tui.close();
      } catch {
        /* best-effort */
      }
      client.events.stop();
      if (proxyProc?.pid) await killPid(proxyProc.pid);
      if (engineProc?.pid) await killPid(engineProc.pid);
      if (!opts.keep && process.env.TESTKIT_KEEP !== "1") {
        try {
          rmSync(paths.root, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      } else {
        console.log(`[testkit] kept scratch dir: ${paths.root}`);
      }
    },
  };

  // Start the event subscription now so nothing before the first assertion is missed.
  client.events.start();
  track(handle);

  // Install any extensions requested up front. On failure, fully stop first —
  // otherwise a caller that catches the rejection has no handle to stop().
  try {
    for (const dir of opts.extensions ?? []) await handle.install(dir);
  } catch (err) {
    await handle.stop().catch(() => {});
    throw err;
  }

  log(`ready: engine :${enginePort} · proxy :${proxyPort} · scratch ${paths.root}`);
  return handle;
}

// ---------------------------------------------------------------------------
// isolation self-check helpers
// ---------------------------------------------------------------------------

export interface LiveServiceFingerprint {
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  ino: number;
}

/**
 * Fingerprint the DEVELOPER'S live registration file (default
 * `<home>/.local/state/opencode/service.json`). Take one before `start()` and
 * one after; an unchanged fingerprint is proof the harness never wrote it.
 * Reads the file only for this proof — the harness itself never opens it.
 */
export function liveServiceFingerprint(home = homedir()): LiveServiceFingerprint {
  // Honor XDG_STATE_HOME (the live registration lives under it when set).
  const base = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const path = join(base, "opencode", "service.json");
  try {
    const st = statSync(path);
    return { path, exists: true, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return { path, exists: false, size: 0, mtimeMs: 0, ino: 0 };
  }
}

/** Recursively list a scratch dir (isolation evidence). */
export function listTree(dir: string, max = 100): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (out.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = join(d, e);
      out.push(p);
      try {
        if (statSync(p).isDirectory()) walk(p);
      } catch {
        /* race */
      }
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// process-level safety net: never leave a rogue engine behind
// ---------------------------------------------------------------------------

const liveHandles = new Set<TestkitHandle>();
export function track(handle: TestkitHandle): TestkitHandle {
  liveHandles.add(handle);
  return handle;
}

function installExitHandlers(): void {
  let shuttingDown = false;
  // Full async teardown on SIGINT/SIGTERM (what `timeout` sends) — this is the
  // path that closes Chromium/Vite/tmux/engine/proxy and removes temp dirs.
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([...liveHandles].map((h) => h.stop()));
    process.exit(code);
  };
  // Sync last resort for a hard `exit` that cannot await: kill our direct
  // children by their own pids only (never a process-wide sweep).
  const syncKill = (): void => {
    for (const h of liveHandles) {
      for (const pid of [h.proxy.pid, h.engine.pid]) {
        try {
          if (pid) process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  };
  process.on("exit", syncKill);
  process.on("SIGINT", () => {
    void shutdown(130);
  });
  process.on("SIGTERM", () => {
    void shutdown(143);
  });
}
installExitHandlers();

if (import.meta.main) {
  console.log(
    "testkit harness.ts is a library — import it from a test.\n" +
      "Worked example: bun run testkit:example",
  );
}
