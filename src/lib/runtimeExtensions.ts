import { disableRuntimeIds, enableRuntimeIds } from "../extensions/registry";
import { isDisabled } from "./extGate";

/**
 * Runtime extension loader — brings plugin-shipped UI halves into the app.
 *
 * Flow:
 *  1. The proxy exposes what plugins shipped: GET /api/webui/extensions →
 *     `{ data: [{ id, url, source }] }`, where `url` is a full same-origin
 *     path INCLUDING a `?v=<mtime>` cache-buster (e.g.
 *     `/api/webui/extensions/acme/bundle.js?v=172…`). `source` names where
 *     the bundle came from (plugin name/path); it's metadata only here.
 *  2. Every 8 seconds (only while the tab is visible; skipped ticks just
 *     wait for the next one) we refetch that manifest and, per entry:
 *       - skip entirely if the user killed it via the extGate kill switch;
 *       - allow-list its id in the registry (`enableRuntimeIds`) so slots/
 *         pages/commands serve whatever it registered;
 *       - import its bundle when we haven't loaded THIS url yet (module-
 *         level `loaded` map id→url; a changed `?v=` re-imports).
 *     Bundles register themselves against `window.__opencodeUI` (installed
 *     in main.tsx BEFORE any render) — the versioned bridge is the ONLY way
 *     they touch the app. They carry their own React copies; the refs are
 *     for their use.
 *  3. After each successful tick, ids still in `loaded` but missing from
 *     the tick's enabled set (dropped server-side OR newly disabled by the
 *     user) get `disableRuntimeIds` + forgotten — Settings toggles apply
 *     within ~8s: OFF unregisters immediately on the next tick, ON imports
 *     on the next tick.
 *
 * Manifest fetch/import failures are silently ignored: the engine or proxy
 * may simply be down, and a transient failure must never unregister
 * anything that is already running.
 *
 * NOTE: the dynamic import() below carries the MANDATORY "@vite-ignore"
 * pragma — without it Vite tries to pre-resolve the URL at build time
 * instead of fetching it from our proxy at runtime.
 */

interface RuntimeExtensionEntry {
  id: string;
  url: string;
}

/** Loaded bundles, id → exact url (with its ?v= version) currently active. */
const loaded = new Map<string, string>();

const POLL_MS = 8_000;

/** Guard so startRuntimeExtensions() is safe to call more than once. */
let started = false;

async function pollOnce(opts?: { force?: boolean }): Promise<void> {
  // Background tabs skip RE-DISCOVERY ticks — but the very first (boot) tick
  // always runs, so extensions are ready the moment the user looks at the
  // tab even if it loaded in the background.
  if (!opts?.force && started && document.hidden) return;

  let entries: RuntimeExtensionEntry[];
  try {
    const res = await fetch("/api/webui/extensions");
    if (!res.ok) return;
    const body: unknown = await res.json();
    const data = (body as { data?: unknown } | null)?.data;
    entries = Array.isArray(data) ? (data as RuntimeExtensionEntry[]) : [];
  } catch {
    return; // engine/proxy down — silently ignore, keep what's running
  }

  // This tick's set of ids the user allows AND the server still ships.
  const enabledNow = new Set<string>();

  for (const entry of entries) {
    if (typeof entry?.id !== "string" || typeof entry?.url !== "string") continue;
    if (isDisabled(entry.id)) continue;

    enabledNow.add(entry.id);
    enableRuntimeIds([entry.id]);

    if (loaded.get(entry.id) === entry.url) continue;
    try {
      await import(/* @vite-ignore */ entry.url);
      loaded.set(entry.id, entry.url);
    } catch {
      // Bundle failed to load/execute — left unrecorded so a later tick
      // retries (e.g. after the plugin finishes writing its files).
    }
  }

  // Stale = loaded but no longer in this tick's enabled set (removed from
  // the server, or newly disabled by the user). Unregister + forget so a
  // later re-enable imports fresh.
  const stale: string[] = [];
  for (const id of loaded.keys()) {
    if (!enabledNow.has(id)) {
      stale.push(id);
      loaded.delete(id);
    }
  }
  if (stale.length > 0) disableRuntimeIds(stale);
}

/** Kicks off polling (immediately, then every 8s while visible). Idempotent. */
export function startRuntimeExtensions(): void {
  if (started) return;
  started = true;
  void pollOnce({ force: true }); // boot tick: unconditional
  setInterval(() => {
    void pollOnce();
  }, POLL_MS);
}
