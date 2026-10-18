/**
 * testkit TUI renderer — turn a captured terminal buffer (WITH ANSI) into a PNG
 * a human can eyeball, using a REAL terminal emulator (xterm.js) inside headless
 * Chromium. Dependency-light: `@xterm/xterm` is already a runtime dependency;
 * the BROWSER is optional and not bundled — it comes from ./browser (the same
 * plan the UI driver uses). With no browser this FAILS SOFT with one actionable
 * line; the text grid (`tmux capture-pane -p`) is unaffected.
 *
 * TWO REPRESENTATIONS, two jobs:
 *   - the ASSERTION SUBSTRATE is the text grid (`tmux capture-pane -p`) — the
 *     agent-optimized, deterministic form; colors carry no layout meaning.
 *   - the HUMAN-FACING RENDER is this PNG — illustrative, NOT a pixel contract.
 *     Terminal emulators disagree on exact widths/glyphs, so never assert on it.
 *
 * Test-only module: modifies neither src/ nor server/.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser as PwBrowser } from "playwright-core";
import { BrowserUnavailableError, resolveBrowser, type BrowserPlan } from "./browser";

export interface RenderOptions {
  /** Path the PNG is written to. */
  outPath: string;
  cols?: number;
  rows?: number;
  fontSize?: number;
  /**
   * The resolved browser plan (from ./browser). Omit to resolve lazily; a plan
   * that is unavailable makes this throw BrowserUnavailableError (fail soft).
   */
  browser?: BrowserPlan;
  /** Chrome executable override (only used when no plan is supplied). */
  chrome?: string;
  log?: (msg: string) => void;
}

export interface RenderResult {
  path: string;
  cols: number;
  rows: number;
  /**
   * The EMULATOR's own rendered text (read back from the page) — a self-check
   * that xterm actually ingested the buffer. Still illustrative; do not assert
   * layout on it.
   */
  text: string;
}

/** Locate xterm.js + its stylesheet from the installed dependency (no bundler). */
function xtermAssets(): { js: string; css: string } {
  let js: string;
  try {
    js = Bun.resolveSync("@xterm/xterm", import.meta.dir);
  } catch (err) {
    throw new Error(
      `[testkit-tui] @xterm/xterm not found — it ships as a runtime dependency of opencode-webui (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const css = join(dirname(js), "..", "css", "xterm.css");
  if (!existsSync(js) || !existsSync(css)) {
    throw new Error(`[testkit-tui] xterm assets missing (js=${js}, css=${css})`);
  }
  return { js, css };
}

/**
 * Render an ANSI terminal buffer to a PNG via xterm.js in headless Chromium.
 * The page is built from the installed xterm.js UMD bundle (a global
 * `Terminal`), so no new dependency and no bundling are needed.
 */
export async function renderAnsiToPng(ansi: string, opts: RenderOptions): Promise<RenderResult> {
  const cols = opts.cols ?? 220;
  const rows = opts.rows ?? 50;
  const fontSize = opts.fontSize ?? 14;
  const log = opts.log ?? (() => {});
  const plan = opts.browser ?? (await resolveBrowser({ chrome: opts.chrome }));
  if (!plan.available || !plan.chromium) throw new BrowserUnavailableError(plan.reason);
  const { js, css } = xtermAssets();
  mkdirSync(dirname(opts.outPath), { recursive: true, mode: 0o700 });

  const browser = (await plan.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(plan.executablePath ? { executablePath: plan.executablePath } : {}),
  })) as PwBrowser;
  try {
    const page = await browser.newPage({
      viewport: { width: Math.max(480, cols * 9 + 32), height: Math.max(240, rows * 18 + 32) },
      deviceScaleFactor: 2,
    });
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head>' +
        '<body style="margin:0;background:#11111b;padding:12px"><div id="t"></div></body></html>',
    );
    await page.addStyleTag({ path: css });
    await page.addScriptTag({ path: js });
    log(`rendering ${cols}x${rows} buffer via xterm.js → ${opts.outPath}`);
    const text = await page.evaluate(
      (input: { ansi: string; cols: number; rows: number; fontSize: number }) =>
        new Promise<string>((resolve) => {
          const T = (globalThis as unknown as { Terminal: new (o: unknown) => any }).Terminal;
          const term = new T({
            cols: input.cols,
            rows: input.rows,
            fontSize: input.fontSize,
            fontFamily: '"DejaVu Sans Mono", Menlo, Consolas, monospace',
            cursorBlink: false,
            convertEol: false,
            scrollback: 0,
            theme: { background: "#11111b", foreground: "#cdd6f4" },
          });
          term.open(document.getElementById("t"));
          // write() invokes the callback once the buffer is parsed; two frames
          // let the renderer paint before we read it back / screenshot.
          term.write(input.ansi, () => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const el = document.querySelector(".xterm-rows") ?? document.getElementById("t");
                resolve(el ? (el as HTMLElement).innerText : "");
              }),
            );
          });
        }),
      { ansi, cols, rows, fontSize },
    );
    await page.locator("#t").screenshot({ path: opts.outPath });
    return { path: opts.outPath, cols, rows, text };
  } finally {
    await browser.close();
  }
}
