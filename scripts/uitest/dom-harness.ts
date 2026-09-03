#!/usr/bin/env bun
/**
 * Shared DOM-stratum test harness (R-T1 — generalizes the rich-render CDP pattern).
 *
 *   import { serveFixtureDir, launchChrome, connectPage, … } from "./dom-harness";
 *
 * What it provides (fixture page serving, headless-Chrome evaluate helper,
 * settled-wait helper) — everything the one-off `rr-cdp.ts` port script
 * hand-rolled, as importable helpers:
 *
 *   serveFixtureDir(dir)      tiny Bun static server for a fixture dir (port 0 → actual)
 *   buildDomBundle(entry, out) Bun.build a dom-test entry (domKit + ext dom.ts)
 *   launchChrome()            headless system chrome w/ remote debugging (+ cleanup)
 *   connectPage(debugPort)    wait for /json/list, return the page target's wsUrl
 *   Cdp                       minimal CDP client: call/evaluate/waitFor + error tap
 *   waitSettled(cdp, expr)    page predicate true on N consecutive reads (settle gate)
 *
 * Constraints: bun + system chrome only, no new dependencies. Ports/scratch
 * are caller-chosen (pass explicit dirs/ports or port 0); everything this
 * module spawns is torn down by the returned cleanup fns.
 *
 * Test-only file: asserts nothing, modifies neither src/ nor server/.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class HarnessError extends Error {
  constructor(message: string) {
    super(`[dom-harness] ${message}`);
    this.name = "HarnessError";
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A free loopback port, by definition ours to use (bind-then-release). */
export function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port;
  s.stop(true);
  if (typeof port !== "number" || port <= 0) throw new HarnessError("could not obtain a free port");
  return port;
}

// ---------------------------------------------------------------------------
// fixture page serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export interface FixtureServer {
  port: number;
  url: (path?: string) => string;
  stop: () => void;
}

/** Serve static files from `dir` on 127.0.0.1 (port 0 = pick free). No directory listing. */
export function serveFixtureDir(dir: string, port = 0): FixtureServer {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      if (rel.includes("..")) return new Response("forbidden", { status: 403 });
      const file = Bun.file(join(dir, rel));
      return file.exists().then((ok) => {
        if (!ok) return new Response("not found", { status: 404 });
        const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
        return new Response(file, {
          headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
        });
      });
    },
  });
  const actual = server.port;
  if (typeof actual !== "number" || actual <= 0) throw new HarnessError("fixture server did not bind");
  return {
    port: actual,
    url: (path = "/") => `http://127.0.0.1:${actual}${path.startsWith("/") ? path : `/${path}`}`,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// dom bundle building (the rr-test-entry.ts pattern: domKit + ext dom module)
// ---------------------------------------------------------------------------

export interface DomBundleOptions {
  /** Extension id the test mounts under (matches data-oc-dom-ext scoping). */
  extId: string;
  /** Absolute path to the extension's dom.ts. */
  domPath: string;
  /** Absolute path of the generated entry .ts (written for you). */
  entryPath: string;
  /** Global the entry exposes, e.g. `__rr` → window.__rr.mount/dispose. */
  globalName?: string;
}

/**
 * Write a test entry that mounts the REAL domKit against the REAL ext dom
 * module behind `window.<global>.mount()/dispose()` (the rr-test-entry.ts
 * pattern), then build it to `outPath` (browser ESM). Returns bundle bytes.
 */
export async function buildDomBundle(opts: DomBundleOptions, outPath: string): Promise<Uint8Array> {
  const globalName = opts.globalName ?? "__domHarness";
  const domKitPath = join(import.meta.dir, "..", "..", "src", "lib", "domKit.ts");
  const entrySource = [
    `import { mountDomExtension, disposeDomExtension } from ${JSON.stringify(domKitPath)};`,
    `import mod from ${JSON.stringify(opts.domPath)};`,
    `const w = window as unknown as { ${globalName}: Record<string, () => unknown> };`,
    `w.${globalName} = {`,
    `  mount: () => mountDomExtension(${JSON.stringify(opts.extId)}, mod),`,
    `  dispose: () => disposeDomExtension(${JSON.stringify(opts.extId)}, mod),`,
    `};`,
  ].join("\n");
  await Bun.write(opts.entryPath, entrySource);
  return buildEntryBundle(opts.entryPath, outPath);
}

/**
 * Simpler deterministic variant: caller writes the entry source; we build
 * entry → out with Bun.build (browser ESM). Returns the bundle bytes.
 */
export async function buildEntryBundle(entryPath: string, outPath: string): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(outPath, ".."),
    naming: `${outPath.split("/").pop()?.replace(/\.js$/, "")}.[ext]`,
    target: "browser",
    format: "esm",
  });
  if (!result.success) {
    const logs = result.logs.map((l) => String(l)).join("\n").slice(0, 1_000);
    throw new HarnessError(`Bun.build failed for ${entryPath}:\n${logs}`);
  }
  const file = Bun.file(outPath);
  if (!(await file.exists())) throw new HarnessError(`expected bundle at ${outPath} was not written`);
  return new Uint8Array(await file.arrayBuffer());
}

// ---------------------------------------------------------------------------
// headless chrome
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  process.env.CHROME ?? "",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome(): string {
  for (const c of CHROME_CANDIDATES) {
    if (c && existsSync(c)) return c;
  }
  for (const bin of ["google-chrome", "chromium", "chromium-browser"]) {
    const found = Bun.spawnSync(["which", bin]);
    if (found.exitCode === 0) {
      const p = found.stdout.toString().trim().split("\n")[0]?.trim();
      if (p && existsSync(p)) return p;
    }
  }
  throw new HarnessError(`no system chrome found (tried ${CHROME_CANDIDATES.filter(Boolean).join(", ")} + PATH; set CHROME=)`);
}

export interface ChromeInstance {
  debugPort: number;
  proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
  kill: () => Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Launch headless system chrome with remote debugging. Caller owns kill(). */
export function launchChrome(opts: { debugPort?: number; windowSize?: string } = {}): ChromeInstance {
  const chrome = findChrome();
  const debugPort = opts.debugPort ?? freePort();
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${debugPort}`,
      `--window-size=${opts.windowSize ?? "1280,900"}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const kill = async (): Promise<void> => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && pidAlive(proc.pid)) await sleep(150);
    if (pidAlive(proc.pid)) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  return { debugPort, proc, kill };
}

export interface PageTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Wait for the debugger endpoint and return the first page target's wsUrl. */
export async function connectPage(debugPort: number, timeoutMs = 20_000): Promise<string> {
  const t0 = Date.now();
  let last = "no response";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const targets = (await res.json()) as PageTarget[];
        const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
        last = `${targets.length} target(s), no page yet`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 80) : String(err);
    }
    await sleep(250);
  }
  throw new HarnessError(`chrome debugger on :${debugPort} yielded no page target after ${timeoutMs}ms (last: ${last})`);
}

// ---------------------------------------------------------------------------
// minimal CDP client (evaluate helper + settled-wait helper + error tap)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export class Cdp {
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
          if (msg.error) p.reject(new HarnessError(`CDP ${msg.error.message ?? JSON.stringify(msg.error)}`));
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
      const timer = setTimeout(() => reject(new HarnessError("CDP websocket: open timeout")), timeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new HarnessError("CDP websocket: error"));
      });
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HarnessError(`CDP timeout: ${method}`));
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
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate JS in the page (awaitPromise + returnByValue, like rr-cdp evalJs). */
  async evaluate(expression: string, awaitPromise = true): Promise<unknown> {
    const res = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new HarnessError(`evaluate failed: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
    }
    return res?.result?.value;
  }

  /** Enable the domains a fixture page needs, then navigate to it. */
  async goto(url: string): Promise<void> {
    await this.call("Page.enable");
    await this.call("Runtime.enable");
    await this.call("Page.navigate", { url });
  }

  /**
   * Poll a boolean page expression until true or timeout (the rr-cdp
   * sleep-then-read pattern, generalized).
   */
  async waitFor(
    expression: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<{ ok: true } | { ok: false; last: unknown }> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const intervalMs = opts.intervalMs ?? 250;
    const t0 = Date.now();
    let last: unknown = "not evaluated";
    while (Date.now() - t0 < timeoutMs) {
      try {
        last = await this.evaluate(expression);
        if (last === true) return { ok: true };
      } catch (err) {
        last = `eval-error: ${err instanceof Error ? err.message : String(err)}`;
      }
      await sleep(intervalMs);
    }
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

/**
 * Settled-wait helper: resolves true once `expression` reads true on
 * `stableReads` CONSECUTIVE polls (generalizes the rich-render settle gate —
 * "identical reads across quiet windows" — to the test side, so assertions
 * never race a mid-stream DOM).
 */
export async function waitSettled(
  cdp: Cdp,
  expression: string,
  opts: { timeoutMs?: number; intervalMs?: number; stableReads?: number } = {},
): Promise<{ ok: true; reads: number } | { ok: false; last: unknown }> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const stableReads = opts.stableReads ?? 2;
  const t0 = Date.now();
  let consecutive = 0;
  let reads = 0;
  let last: unknown = "not evaluated";
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await cdp.evaluate(expression);
      reads += 1;
      if (last === true) {
        consecutive += 1;
        if (consecutive >= stableReads) return { ok: true, reads };
      } else {
        consecutive = 0;
      }
    } catch (err) {
      consecutive = 0;
      last = `eval-error: ${err instanceof Error ? err.message : String(err)}`;
    }
    await sleep(intervalMs);
  }
  return { ok: false, last };
}

// ---------------------------------------------------------------------------
// one-shot convenience: serve + chrome + page, run fn, tear everything down
// ---------------------------------------------------------------------------

export interface DomSession {
  cdp: Cdp;
  baseUrl: string;
}

/**
 * Run `fn` against a fresh headless page with `fixtureDir` served.
 * Own ports only (fixture :0, chrome :0); kills chrome + stops the server
 * even when fn throws.
 */
export async function withDomPage<T>(
  fixtureDir: string,
  fn: (session: DomSession) => Promise<T>,
): Promise<T> {
  const server = serveFixtureDir(fixtureDir);
  const chrome = launchChrome({ debugPort: freePort() });
  let cdp: Cdp | null = null;
  try {
    const wsUrl = await connectPage(chrome.debugPort);
    cdp = new Cdp(wsUrl);
    await cdp.open();
    return await fn({ cdp, baseUrl: server.url() });
  } finally {
    cdp?.close();
    await chrome.kill();
    server.stop();
  }
}

if (import.meta.main) {
  console.log(
    "dom-harness.ts is a library — import it from a battery step.\n" +
      "Proof that it works: bun scripts/uitest/dom-harness-proof.ts",
  );
}
