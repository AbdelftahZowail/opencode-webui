/**
 * testkit browser resolution — point testkit at the browser the ENVIRONMENT
 * already has; NEVER bundle or require one.
 *
 * The browser half of testkit is OPTIONAL. The agent's environment (or the
 * developer's machine) already knows how to drive a web page, so testkit only
 * *locates* a usable Chromium and uses it. When there is none, the browser
 * checks (`handle.ui`, `tui.renderPng()`) FAIL SOFT with one actionable line
 * and the rest of the run (engine / proxy / TUI text grid) proceeds — see
 * `NO_BROWSER`.
 *
 * Resolution order (first hit wins):
 *   1. explicit   — `opts.chrome` / `TESTKIT_CHROME`
 *   2. env pointer— CHROME_PATH / CHROMIUM_PATH / CHROME
 *   3. driver cache — playwright-core's own browser from the Playwright cache
 *      (`chromium.executablePath()`, ~/.cache/ms-playwright). Preferring this
 *      over auto-discovery is deliberate: it is the driver's known-good browser
 *      (a distro/Snap Chromium on PATH is often confined and un-launchable).
 *   4. PATH       — chromium / chromium-browser / google-chrome
 *   5. none       — degrade (the browser checks skip cleanly)
 *
 * Every branch needs the DRIVER (`playwright-core`) to be resolvable — that
 * library is how we talk to any of these browsers. No driver ⇒ no browser half;
 * that is what keeps a consumer of this package browser-dependency-free.
 *
 * Test-only module: modifies neither src/ nor server/.
 */

import { existsSync } from "node:fs";

/** Where a resolved browser came from (debug/evidence). */
export type BrowserSource = "explicit" | "env" | "playwright-cache" | "path";

export interface BrowserPlan {
  /** True when a browser + driver are both available. */
  available: boolean;
  source?: BrowserSource;
  /** The Chromium executable the driver should launch (set when available). */
  executablePath?: string;
  /** Why the browser half is off (set only when unavailable). */
  reason?: string;
  /** The resolved `playwright-core` launcher (set iff available). */
  chromium?: ChromiumLauncher;
}

/** The minimal shape of `playwright-core`'s `chromium` export we use. */
export interface ChromiumLauncher {
  executablePath(): string;
  launch(options?: Record<string, unknown>): Promise<unknown>;
}

/** The one actionable line every no-browser failure carries. */
export const NO_BROWSER =
  "no browser available — install one or set CHROME_PATH; the engine/proxy/TUI-text checks ran";

/** Thrown by any browser-dependent driver method when no browser is available. */
export class BrowserUnavailableError extends Error {
  constructor(detail?: string) {
    super(detail ? `${NO_BROWSER}\n  (${detail})` : NO_BROWSER);
    this.name = "BrowserUnavailableError";
  }
}

/** Load playwright-core on demand — the only runtime reference to it in testkit. */
async function loadDriver(): Promise<ChromiumLauncher | null> {
  try {
    const mod = (await import("playwright-core")) as { chromium?: ChromiumLauncher };
    return mod.chromium ?? null;
  } catch {
    return null;
  }
}

function firstExisting(paths: (string | undefined)[]): string | undefined {
  for (const p of paths) if (p && existsSync(p)) return p;
  return undefined;
}

/** First of `names` found on PATH (via `which`). */
function firstOnPath(names: string[]): string | undefined {
  for (const name of names) {
    try {
      const res = Bun.spawnSync(["which", name]);
      if (res.exitCode === 0) {
        const p = res.stdout.toString().trim().split("\n")[0]?.trim();
        if (p) return p;
      }
    } catch {
      /* `which` itself is missing — treat as not found */
    }
  }
  return undefined;
}

/**
 * Resolve the browser the environment already has. Never spawns or downloads
 * one; returns `{ available: false, reason }` when there is none.
 */
export async function resolveBrowser(opts: { chrome?: string } = {}): Promise<BrowserPlan> {
  if (process.env.TESTKIT_NO_BROWSER === "1") {
    return { available: false, reason: "TESTKIT_NO_BROWSER=1 (forced off)" };
  }
  const driver = await loadDriver();

  // (1) explicit override — a deliberate choice; trust it if it exists.
  const explicit = opts.chrome ?? process.env.TESTKIT_CHROME;
  if (explicit) {
    if (!existsSync(explicit)) return { available: false, reason: `explicit chrome not found: ${explicit}` };
    return driver
      ? { available: true, source: "explicit", executablePath: explicit, chromium: driver }
      : { available: false, reason: `found ${explicit} but playwright-core (the driver) is not resolvable` };
  }

  // (2) an env pointer — also deliberate (honor CHROME_PATH / CHROMIUM_PATH / CHROME).
  const envExe = firstExisting([process.env.CHROME_PATH, process.env.CHROMIUM_PATH, process.env.CHROME]);
  if (envExe) {
    return driver
      ? { available: true, source: "env", executablePath: envExe, chromium: driver }
      : { available: false, reason: `found ${envExe} (from the environment) but playwright-core (the driver) is not resolvable` };
  }

  // (3) the driver's own known-good browser from the Playwright cache.
  if (driver) {
    try {
      const ep = driver.executablePath();
      if (ep && existsSync(ep)) return { available: true, source: "playwright-cache", executablePath: ep, chromium: driver };
    } catch {
      /* no cached browser */
    }
  }

  // (4) a system Chromium on PATH (last resort — may be confined/un-launchable).
  const onPath = firstOnPath(["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]);
  if (onPath) {
    return driver
      ? { available: true, source: "path", executablePath: onPath, chromium: driver }
      : { available: false, reason: `found ${onPath} on PATH but playwright-core (the driver) is not resolvable` };
  }

  // (5) none.
  return {
    available: false,
    reason: driver
      ? "no Chromium binary found (checked CHROME_PATH/CHROMIUM_PATH/CHROME, the Playwright cache, and PATH)"
      : "playwright-core (the driver) is not resolvable in this environment",
  };
}
