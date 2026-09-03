/**
 * Proxy-stratum loader + mount points (spec §8 scaffolding).
 *
 * Discovery: every extension dir root is scanned for `<name>/server.ts`
 * (plus `manifest.json` for `{ id, disabled }`). Roots, in precedence
 * order: user dir → project dir → shipped `webui-extensions/` (when it
 * exists). Same id at higher precedence wins; `disabled: true` pauses.
 * Presence = installed, delete/move = uninstalled — same gating rule as
 * every other stratum.
 *
 * Hot reload: stat-poll (2s) + ESM re-import with `?v=<mtime>` cache-bust.
 * No proxy restart for code edits (dev's existing `--watch` restart stays;
 * SSE self-reconnects). The proven suggestion in the spec is CJS require
 * with cache deletion; the equivalent used here is query-busted dynamic
 * import — same property (fresh module per mtime), no restart.
 *
 * Mount points provided (core stays thin and non-forkable):
 * - `dispatchExtRequest(req, url)` — routes auto-mounted at
 *   `/api/webui/ext/<id>/…`, called BEFORE the generic /api proxy.
 * - `runExtRequestMiddleware` / `applyExtResponseMiddleware` — wrap the
 *   `/api/*` passthrough chain (uniform transforms, all clients).
 * - `dispatchExtEvent(evt)` — tap into the recorder's always-on engine
 *   event subscription; called from `recordEvent()` in index.ts.
 * - `startExtModules()` — boot hook: discover + start pollers/schedules
 *   (always-on ticks that survive closed tabs).
 *
 * GAPS (follow-ups, not in this scaffolding):
 * - `server/` directory form (only bare `server.ts` is discovered).
 * - SSE manifest push for server-module versions (browser bundle only).
 * (Engine credentials shipped as `ctx.engine` — see `engine.ts`.)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalUserExtensionsDir, projectUserExtensionsDir, warnOnce } from "../userExtensions";
import { engine } from "./engine";
import { kvFor } from "./kv";
import type { ExtEngineEvent, ExtServerContext, ServerExtensionModule } from "./types";

const POLL_MS = 2_000;

type LoadedExt = {
  id: string;
  dir: string;
  entry: string;
  mtimeMs: number;
  module: ServerExtensionModule;
  timers: ReturnType<typeof setInterval>[];
};

const loaded = new Map<string, LoadedExt>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function shippedDir(): string | null {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = join(root, "webui-extensions");
  return existsSync(dir) ? dir : null;
}

function readManifest(dir: string): { id?: string; disabled?: boolean } {
  try {
    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    return JSON.parse(raw) as { id?: string; disabled?: boolean };
  } catch {
    return {};
  }
}

/** Structural validation — extensions need no import of core types. */
function isServerExtensionModule(obj: unknown): obj is ServerExtensionModule {
  if (typeof obj !== "object" || obj === null) return false;
  const m = obj as Record<string, unknown>;
  for (const key of ["routes", "pollers"]) {
    if (m[key] !== undefined && !Array.isArray(m[key])) return false;
  }
  const mw = m["middleware"];
  if (mw !== undefined && (typeof mw !== "object" || mw === null)) return false;
  if (m["onEvent"] !== undefined && typeof m["onEvent"] !== "function") return false;
  if (m["dispose"] !== undefined && typeof m["dispose"] !== "function") return false;
  return true;
}

function ctxFor(id: string): ExtServerContext {
  return { extID: id, kv: kvFor(id), engine };
}

async function loadEntry(id: string, dir: string, entry: string): Promise<void> {
  const mtimeMs = statSync(entry).mtimeMs;
  // Bare-path + ?v= busts Bun's module cache; file:// URLs do NOT (verified:
  // file://…?v= serves stale in a long-lived process while /path?v= is fresh).
  const url = `${entry}?v=${mtimeMs}`;
  const imported = (await import(url)) as { default?: unknown };
  const mod = imported.default;
  if (!isServerExtensionModule(mod)) {
    warnOnce(`ext-shape:${id}`, `server extension "${id}" has no valid default export — skipped`);
    return;
  }
  // Swap path: stop the old module's pollers BEFORE installing the new one.
  unloadEntry(id);
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const poller of mod.pollers ?? []) {
    const ctx = ctxFor(id);
    const timer = setInterval(() => {
      try {
        const r = poller.run(ctx);
        if (r instanceof Promise) r.catch((err) => console.error(`[webui] ext "${id}" poller "${poller.id}" failed:`, err));
      } catch (err) {
        console.error(`[webui] ext "${id}" poller "${poller.id}" failed:`, err);
      }
    }, poller.intervalMs);
    timers.push(timer);
  }
  loaded.set(id, { id, dir, entry, mtimeMs, module: mod, timers });
  console.log(`[webui] server extension loaded: ${id}`);
}

function unloadEntry(id: string): void {
  const prev = loaded.get(id);
  if (!prev) return;
  for (const t of prev.timers) clearInterval(t);
  try {
    prev.module.dispose?.();
  } catch (err) {
    console.error(`[webui] ext "${id}" dispose failed:`, err);
  }
  loaded.delete(id);
}

/** One discovery pass: load new/changed, unload removed/disabled. */
async function discoverOnce(): Promise<void> {
  const roots = [globalUserExtensionsDir(), projectUserExtensionsDir(), shippedDir()];
  const seen = new Map<string, { dir: string; entry: string }>();
  for (const root of roots) {
    if (!root) continue;
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name)) continue; // higher-precedence root wins
      const entry = join(root, name, "server.ts");
      try {
        if (!existsSync(entry)) continue;
      } catch {
        continue;
      }
      seen.set(name, { dir: join(root, name), entry });
    }
  }

  // Removed from disk (or newly disabled) → unload.
  for (const id of [...loaded.keys()]) {
    const found = seen.get(id);
    if (!found) {
      unloadEntry(id);
      continue;
    }
    if (readManifest(found.dir).disabled === true) unloadEntry(id);
  }

  // New or mtime-moved → (re)load. Disabled = paused, never loaded.
  for (const [name, { dir, entry }] of seen) {
    let manifestId = name;
    try {
      if (readManifest(dir).disabled === true) continue;
      const mid = readManifest(dir).id;
      if (mid) manifestId = mid;
    } catch {
      /* unreadable manifest — load by folder name */
    }
    const prev = loaded.get(manifestId);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(entry).mtimeMs;
    } catch {
      continue;
    }
    if (!prev || prev.mtimeMs !== mtimeMs || prev.entry !== entry) {
      try {
        await loadEntry(manifestId, dir, entry);
      } catch (err) {
        console.error(`[webui] server extension "${manifestId}" failed to load:`, err);
      }
    }
  }
}

/** Boot hook (idempotent): initial discovery + stat-poll. Call once. */
export function startExtModules(): void {
  if (pollTimer) return;
  void discoverOnce().catch((err) => console.error("[webui] ext discovery failed:", err));
  pollTimer = setInterval(() => {
    void discoverOnce().catch((err) => console.error("[webui] ext re-discovery failed:", err));
  }, POLL_MS);
}

/**
 * Route dispatch for `/api/webui/ext/<id>/…`. Returns a Response when an
 * extension route handled it, `null` to fall through (unknown id/route →
 * the caller 404s; never falls through to the engine).
 */
export async function dispatchExtRequest(req: Request, url: URL): Promise<Response | null> {
  const rest = url.pathname.slice("/api/webui/ext/".length);
  const slash = rest.indexOf("/");
  const id = slash < 0 ? rest : rest.slice(0, slash);
  const suffix = slash < 0 ? "" : rest.slice(slash + 1);
  const ext = loaded.get(decodeURIComponent(id));
  if (!ext) return null;
  const method = req.method.toUpperCase();
  for (const route of ext.module.routes ?? []) {
    const routeMethod = (route.method ?? "GET").toUpperCase();
    if (routeMethod !== method) continue;
    const want = route.path.replace(/^\/+|\/+$/g, "");
    if (decodeURIComponent(suffix).replace(/^\/+|\/+$/g, "") !== want) continue;
    try {
      return await route.handler(req, {
        ...ctxFor(ext.id),
        url,
        params: suffix ? suffix.split("/") : [],
      });
    } catch (err) {
      console.error(`[webui] ext "${ext.id}" route "${route.path}" failed:`, err);
      return Response.json({ error: `extension route failed: ${ext.id}/${route.path}` }, { status: 500 });
    }
  }
  return null;
}

/**
 * Request middleware: first non-void result wins. A returned Response
 * short-circuits the `/api/*` passthrough; a returned Request replaces it.
 */
export async function runExtRequestMiddleware(req: Request): Promise<Request | Response | null> {
  for (const ext of loaded.values()) {
    const fn = ext.module.middleware?.onRequest;
    if (!fn) continue;
    try {
      const out = await fn(req, ctxFor(ext.id));
      if (out instanceof Request || out instanceof Response) return out;
    } catch (err) {
      console.error(`[webui] ext "${ext.id}" onRequest failed:`, err);
    }
  }
  return null;
}

/** Response middleware: each may replace the upstream response in order. */
export async function applyExtResponseMiddleware(res: Response, req: Request): Promise<Response> {
  let current = res;
  for (const ext of loaded.values()) {
    const fn = ext.module.middleware?.onResponse;
    if (!fn) continue;
    try {
      const out = await fn(current, req, ctxFor(ext.id));
      if (out instanceof Response) current = out;
    } catch (err) {
      console.error(`[webui] ext "${ext.id}" onResponse failed:`, err);
    }
  }
  return current;
}

/** Event tap: headless reaction to the recorder's always-on subscription. */
export async function dispatchExtEvent(evt: ExtEngineEvent): Promise<void> {
  for (const ext of loaded.values()) {
    const fn = ext.module.onEvent;
    if (!fn) continue;
    try {
      await fn(evt, ctxFor(ext.id));
    } catch (err) {
      console.error(`[webui] ext "${ext.id}" onEvent failed:`, err);
    }
  }
}
