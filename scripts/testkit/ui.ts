/**
 * testkit UI driver — the REAL browser as the test client.
 *
 *   const ui = createUi({ root, proxyPort, artifactsDir });
 *   await ui.goto("/");
 *   await ui.waitForSelector("[data-testkit-echo]");
 *   await ui.clickText("New session");
 *   await ui.fill("[data-oc-composer-input]", "hello");
 *   await ui.press("[data-oc-composer-input]", "Enter");
 *   await ui.screenshot();                 // saved artifact
 *   console.log(await ui.bodyText());       // rendered DOM text = evidence
 *
 * Real Chromium via the environment's Playwright. It drives actual clicks/typing
 * and reads the RENDERED DOM — an API response is a claim; this is evidence.
 *
 * The browser is OPTIONAL and NOT bundled: `opts.browser` is the plan resolved
 * by ./browser. With no browser, every method FAILS SOFT with one actionable
 * line (BrowserUnavailableError) — callers gate on `ui.available` and skip.
 *
 * Two topologies, one driver:
 *   - repo checkout (an in-repo `vite.config.ts`): the proxy does NOT serve the
 *     built UI (dev topology), so this driver launches the Vite dev server
 *     itself, pointed at the harness proxy port.
 *   - installed package / compiled binary: the proxy serves the built `dist/`,
 *     so the driver points the real browser straight at the proxy.
 *
 * Lazy: constructing the driver spawns nothing; the first call starts
 * Vite (dev only) + Chromium once (single-flight) and every method awaits that.
 *
 * Test-only module: modifies neither src/ nor server/.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { BrowserUnavailableError, type BrowserPlan } from "./browser";

export interface UiOptions {
  /** Repo root (Vite cwd). */
  root: string;
  /** The isolated proxy port (`WEBUI_PROXY_PORT` for Vite's /api proxy). */
  proxyPort: number;
  /** Directory screenshots are written into. */
  artifactsDir: string;
  /** The resolved browser plan (see ./browser) — the browser is optional. */
  browser: BrowserPlan;
  /** Extra env for Vite. */
  env?: Record<string, string>;
  log?: (msg: string) => void;
}

export interface UiDriver {
  /** True when a browser is available (the plan resolved one). */
  readonly available: boolean;
  /** True once Vite + Chromium are up. */
  readonly started: boolean;
  /** The app URL (Vite), or null before start. */
  readonly appUrl: string | null;
  /** Ensure Vite + Chromium are up (idempotent). */
  start(): Promise<void>;

  /** Navigate the real app (default "/"). */
  goto(path?: string): Promise<void>;
  /** Current page URL. */
  url(): string;
  /** Evaluate JS in the page and return the value. */
  evaluate<T = unknown>(expr: string): Promise<T>;
  /** Wait until a page expression reads true (default 15s). */
  waitFor(expr: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  /** Wait for a selector to be attached+visible (default 15s). */
  waitForSelector(sel: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Real mouse click on a selector. */
  click(sel: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Real mouse click on the first element whose rendered text matches. */
  clickText(text: string, opts?: { timeoutMs?: number; exact?: boolean }): Promise<void>;
  /** Real typing into an input/textarea/contenteditable (React onChange fires). */
  fill(sel: string, text: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Press a key while the selector is focused (e.g. "Enter"). */
  press(sel: string, key: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Rendered textContent of a selector (null when absent). */
  text(sel: string): Promise<string | null>;
  /** Count of elements matching a selector. */
  count(sel: string): Promise<number>;
  /** Full visible body text of the rendered page. */
  bodyText(): Promise<string>;
  /** innerHTML of the first matching selector (default body). */
  html(sel?: string): Promise<string>;
  /** Screenshot PNG; writes to `path` (or artifactsDir/shot-<ts>.png), returns the path. */
  screenshot(path?: string): Promise<string>;
  /** Recent page console errors/warnings + uncaught exceptions. */
  consoleTail(max?: number): string;
  /** Close the browser + Vite (idempotent). */
  close(): Promise<void>;
}

export function createUi(opts: UiOptions): UiDriver {
  const log = opts.log ?? (() => {});
  const plan = opts.browser;
  let appUrl: string | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let vite: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let viteLog = "";
  const consoleLines: string[] = [];
  let starting: Promise<void> | null = null;

  const started = (): boolean => browser !== null && page !== null;

  function freePort(): number {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const p = s.port;
    s.stop(true);
    if (typeof p !== "number" || p <= 0) throw new Error("[testkit-ui] could not obtain a free port");
    return p;
  }

  function pump(stream: ReadableStream<Uint8Array> | null): void {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) viteLog += dec.decode(value, { stream: true });
        }
      } catch {
        /* torn down */
      }
    })();
  }

  async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "no response";
    while (Date.now() < deadline) {
      if (vite && vite.exitCode !== null) {
        throw new Error(`[testkit-ui] Vite exited (code ${vite.exitCode}) before it served:\n${viteLog.slice(-1_500)}`);
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (res.ok || res.status < 500) return;
        last = `HTTP ${res.status}`;
      } catch (err) {
        last = err instanceof Error ? err.message.slice(0, 120) : String(err);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`[testkit-ui] Vite never served ${url} within ${timeoutMs}ms (last: ${last})\n${viteLog.slice(-1_500)}`);
  }

  async function doStart(): Promise<void> {
    if (started()) return;
    // Fail soft BEFORE spawning anything (Vite included): no browser ⇒ one
    // clear, actionable line; callers gate on `available` and skip.
    if (!plan.available || !plan.chromium) throw new BrowserUnavailableError(plan.reason);
    // Repo checkout → Vite owns the UI; installed package/binary → the proxy
    // serves the built dist/. The in-repo vite.config.ts is the tell.
    const devLayout = existsSync(join(opts.root, "vite.config.ts"));
    let url: string;
    if (devLayout) {
      const vitePort = freePort();
      const viteBin = join(opts.root, "node_modules", ".bin", "vite");
      if (!existsSync(viteBin)) throw new Error(`[testkit-ui] vite not found at ${viteBin}`);
      log(`starting Vite on :${vitePort} (proxy :${opts.proxyPort})`);
      vite = Bun.spawn([viteBin, "--strictPort"], {
        cwd: opts.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...(process.env as Record<string, string>),
          WEBUI_PROXY_PORT: String(opts.proxyPort),
          WEBUI_VITE_PORT: String(vitePort),
          WEBUI_SANDBOX: "1",
          WEBUI_HOST: "127.0.0.1",
          ...(opts.env ?? {}),
        },
      });
      pump(vite.stdout);
      pump(vite.stderr);
      url = `http://127.0.0.1:${vitePort}`;
    } else {
      // The proxy serves dist/ directly (npm package / compiled binary).
      url = `http://127.0.0.1:${opts.proxyPort}`;
      log(`using the proxy's built UI at ${url}`);
    }
    await waitForHttp(`${url}/`, 40_000);
    appUrl = url;

    const chromium = plan.chromium;
    browser = (await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(plan.executablePath ? { executablePath: plan.executablePath } : {}),
    })) as Browser;
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") consoleLines.push(`console.${t}: ${msg.text()}`.slice(0, 300));
      if (consoleLines.length > 60) consoleLines.splice(0, consoleLines.length - 60);
    });
    page.on("pageerror", (err) => {
      consoleLines.push(`exception: ${err.message}`.slice(0, 300));
      if (consoleLines.length > 60) consoleLines.splice(0, consoleLines.length - 60);
    });
    log(`Chromium ${browser.version()} up; app at ${url}`);
  }

  async function ensure(): Promise<Page> {
    if (!started()) {
      starting ??= doStart().catch((err) => {
        starting = null; // allow a retry on the next call
        throw err;
      });
      await starting;
    }
    if (!page) throw new Error("[testkit-ui] page unavailable");
    return page;
  }

  function requirePage(): Page {
    if (!page) throw new Error("[testkit-ui] start() has not completed");
    return page;
  }

  function ensureArtifactsDir(): void {
    mkdirSync(opts.artifactsDir, { recursive: true, mode: 0o700 });
  }

  return {
    get available() {
      return plan.available;
    },
    get started() {
      return started();
    },
    get appUrl() {
      return appUrl;
    },
    start: async () => {
      await ensure();
    },

    async goto(path = "/") {
      const p = await ensure();
      const target = path.startsWith("http") ? path : `${appUrl}${path.startsWith("/") ? path : `/${path}`}`;
      await p.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    },

    url() {
      if (!plan.available) throw new BrowserUnavailableError(plan.reason);
      return requirePage().url();
    },

    async evaluate<T = unknown>(expr: string): Promise<T> {
      const p = await ensure();
      try {
        return (await p.evaluate(expr)) as T;
      } catch (err) {
        throw new Error(`[testkit-ui] evaluate failed (${expr.slice(0, 120)}): ${err instanceof Error ? err.message : String(err)}\nconsole tail:\n${consoleLines.slice(-8).join("\n")}`);
      }
    },

    async waitFor(expr: string, o = {}) {
      const p = await ensure();
      try {
        await p.waitForFunction(expr, undefined, { timeout: o.timeoutMs ?? 15_000, polling: o.intervalMs ?? 250 });
      } catch (err) {
        throw new Error(`[testkit-ui] waitFor(${expr.slice(0, 120)}) timed out: ${err instanceof Error ? err.message : String(err)}\nconsole tail:\n${consoleLines.slice(-8).join("\n")}`);
      }
    },

    async waitForSelector(sel, o = {}) {
      const p = await ensure();
      try {
        await p.waitForSelector(sel, { state: "visible", timeout: o.timeoutMs ?? 15_000 });
      } catch (err) {
        throw new Error(`[testkit-ui] waitForSelector(${sel}) timed out: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async click(sel, o = {}) {
      const p = await ensure();
      try {
        await p.click(sel, { timeout: o.timeoutMs ?? 15_000 });
      } catch (err) {
        throw new Error(`[testkit-ui] click(${sel}) failed: ${err instanceof Error ? err.message : String(err)}\nconsole tail:\n${consoleLines.slice(-8).join("\n")}`);
      }
    },

    async clickText(text, o = {}) {
      const p = await ensure();
      try {
        await p.getByText(text, { exact: o.exact ?? false }).first().click({ timeout: o.timeoutMs ?? 15_000 });
      } catch (err) {
        throw new Error(`[testkit-ui] clickText(${JSON.stringify(text)}) failed: ${err instanceof Error ? err.message : String(err)}\nconsole tail:\n${consoleLines.slice(-8).join("\n")}`);
      }
    },

    async fill(sel, text, o = {}) {
      const p = await ensure();
      try {
        await p.fill(sel, text, { timeout: o.timeoutMs ?? 15_000 });
      } catch (err) {
        throw new Error(`[testkit-ui] fill(${sel}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async press(sel, key, o = {}) {
      const p = await ensure();
      try {
        await p.press(sel, key, { timeout: o.timeoutMs ?? 15_000 });
      } catch (err) {
        throw new Error(`[testkit-ui] press(${sel}, ${key}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async text(sel) {
      const p = await ensure();
      return p.textContent(sel);
    },

    async count(sel) {
      const p = await ensure();
      return p.locator(sel).count();
    },

    async bodyText() {
      const p = await ensure();
      return (await p.textContent("body")) ?? "";
    },

    async html(sel = "body") {
      const p = await ensure();
      return (await p.locator(sel).first().innerHTML().catch(() => "")) ?? "";
    },

    async screenshot(path) {
      const p = await ensure();
      ensureArtifactsDir();
      const out = path ?? join(opts.artifactsDir, `shot-${Date.now()}.png`);
      await p.screenshot({ path: out, fullPage: false });
      return out;
    },

    consoleTail(max = 12) {
      return consoleLines.slice(-max).join("\n");
    },

    async close() {
      try {
        await context?.close();
      } catch {
        /* gone */
      }
      try {
        await browser?.close();
      } catch {
        /* gone */
      }
      context = null;
      browser = null;
      page = null;
      if (vite) {
        try {
          vite.kill();
        } catch {
          /* gone */
        }
        try {
          vite.kill("SIGKILL");
        } catch {
          /* gone */
        }
        vite = null;
      }
      starting = null;
    },
  };
}
