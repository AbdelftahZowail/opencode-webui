import { getRegisteredIds, unregisterIds } from "../extensions/registry";
import { fireHooks } from "../extensions/hooks";
import { installExtensionBridge } from "./extensionApi";
import {
  disposeDomExtension,
  isDomExtensionModule,
  mountDomExtension,
  type DomExtensionModule,
} from "./domKit";

/**
 * Runtime extension loader — folder extensions (user > project > shipped,
 * spec §4/§6) plus engine plugin UI halves, served by the proxy.
 *
 * Flow:
 *  1. The proxy exposes the manifest: GET /api/webui/extensions →
 *     `{ data: [{ id, url?, domUrl?, source, origin? } | { id, source, origin?, disabled: true }],
 *     version }`, where `url` is the browser-stratum bundle and `domUrl` the
 *     DOM-stratum bundle (`dom.ts`), each a full same-origin path INCLUDING
 *     a `?v=<mtime>` cache-buster. Either stratum may be absent (a dom-only
 *     or index-only folder); `source` names where the bundle came from; it's
 *     metadata only here. `origin` is user/project/shipped (absent for engine
 *     plugin halves): shipped browser entries carry NO `url` — the in-repo
 *     Vite glob (webui-extensions/index.ts) owns them, and importing them
 *     here too would run module side effects twice (Bug 2). Shipped `domUrl`
 *     still serves (the glob never loads `dom.ts`).
 *  2. The proxy pushes manifest changes over SSE
 *     (GET /api/webui/extensions/events, one `{ type: "webui.extensions",
 *     version }` event per change — the SAME channel carries both strata:
 *     any `dom.ts` edit moves its `?v=`, which changes the manifest JSON and
 *     fires the push). Each event re-fetches the manifest and, per entry:
 *       - unregisters `disabled: true` ids outright (gating is owned by the
 *         folder's manifest.json, not the browser) — including glob-owned
 *         shipped copies the runtime never imported, or pausing a shipped
 *         extension would never take effect;
 *       - skips the browser import when `origin === "shipped"` (glob-owned;
 *         defense in depth alongside the proxy omitting shipped `url`), while
 *         still mounting shipped `domUrl` and still tracking the entry;
 *       - the registry is ungated (presence IS installed): no allow-list step;
 *         whatever it registered is served to targets/collections directly;
 *       - imports its browser bundle when we haven't loaded THIS url yet
 *         (module-level `loaded` map id→url; a changed `?v=` re-imports, and
 *         the registry same-id-swaps → live repaint, no refresh);
 *       - imports its DOM bundle when we haven't mounted THIS domUrl yet
 *         (`loadedDom` map id→{url, module}; a changed `?v=` disposes the old
 *         module and mounts the new one — edits repaint clean, never stack
 *         ghosts).
 *     Delete/move the folder and the id vanishes from the manifest = instant
 *     uninstall. No polling: a `visibilitychange` refetch covers streams that
 *     died while the tab was hidden (EventSource itself auto-reconnects).
 *  3. After each sync, ids still in `loaded`/`loadedDom` but missing from the
 *     sync's enabled set (removed server-side OR newly paused) get
 *     unregistered via their recorded id delta (`loadedIds` — exactly what
 *     the folder's bundle added) + forgotten (browser stratum) or
 *     `disposeDomExtension` + forgotten (DOM stratum) — a paused extension
 *     unregisters on the next event, a re-enabled one imports fresh.
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
  url?: string;
  /** DOM-stratum bundle (`dom.ts`), same `?v=` cache-bust contract as `url`. */
  domUrl?: string;
  source?: string;
  disabled?: boolean;
  /** Which source won discovery (user > project > shipped). Shipped browser
   *  bundles never import here — the in-repo Vite glob owns them. */
  origin?: "user" | "project" | "shipped";
}

/** Loaded browser bundles, id → exact url (with its ?v= version) currently active. */
const loaded = new Map<string, string>();

/**
 * Folder-level id-delta tracking (IN-3, G-F2/F4 remainder — IMPLEMENTED,
 * subsumes the one-id doc rule): manifest id → registry ids its bundle
 * added. Snapshotted around each bundle import (before/after
 * getRegisteredIds()); disable/delete unregisters exactly that set, so a
 * multi-id folder (e.g. brother-agent's hook + two wraps) leaves no ghosts.
 * The one-id guidance stays as guidance (simpler to reason about) but the
 * loader no longer depends on it. Empty set = bundle added nothing new
 * (re-import swap or zero-id bundle) — uninstall falls back to [id].
 */
const loadedIds = new Map<string, Set<string>>();

/** Mounted DOM modules, id → exact domUrl + module (for `dispose` on swap). */
const loadedDom = new Map<string, { url: string; module: DomExtensionModule }>();

/**
 * The `window.__opencodeUI` surface always exists before any bundle
 * executes — installed once at boot (`main.tsx`), re-ensured here so a
 * bundle imported by the very first sync can never race it.
 */
function ensureBridge(): void {
  installExtensionBridge();
}

/** Guard so startRuntimeExtensions() is safe to call more than once. */
let started = false;

async function syncOnce(opts?: { force?: boolean }): Promise<void> {
  ensureBridge();
  // Background tabs skip re-discovery syncs — but the very first (boot) sync
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

  // This sync's set of ids the manifest ships AND leaves enabled.
  const enabledNow = new Set<string>();
  // Ids with a live DOM stratum this sync (drives DOM-stale disposal below).
  const domNow = new Set<string>();
  // Disabled ids this sync — gating is owned by the folder's manifest.json.
  // The runtime never imports a paused bundle, and a paused id that the
  // in-repo glob owns (shipped) must still unregister here, or `disabled`
  // would never turn a shipped extension off (the glob doesn't read flags).
  const disabledNow = new Set<string>();

  for (const entry of entries) {
    if (typeof entry?.id !== "string") continue;
    if (entry.disabled) {
      disabledNow.add(entry.id);
      continue;
    }
    // An entry with neither bundle is a mid-write folder — skip silently so
    // a later sync retries once both files land.
    if (typeof entry?.url !== "string" && typeof entry?.domUrl !== "string") continue;

    if (typeof entry.url === "string") {
      // Shipped browser stratum is owned by the in-repo Vite glob
      // (webui-extensions/index.ts) — importing it here too runs module side
      // effects twice and fires `extension.loaded` twice (Bug 2). Skip the
      // import (defense in depth: the proxy already omits `url` for shipped)
      // but still honor the entry below for DOM + stale purposes. A
      // user/project copy shadowing the same id arrives with origin
      // user/project and its own `url`, so it still imports and same-id-swaps
      // over the glob copy.
      if (entry.origin === "shipped") {
        // Intentionally NOT added to `enabledNow`: the runtime doesn't own
        // this browser copy, so it must never shield a stale runtime entry.
      } else {
        enabledNow.add(entry.id);

        if (loaded.get(entry.id) !== entry.url) {
          const before = new Set(getRegisteredIds());
          try {
            await import(/* @vite-ignore */ entry.url);
            loaded.set(entry.id, entry.url);
            // Id-delta: attribute exactly the registry ids this import added.
            const after = getRegisteredIds();
            let owned = loadedIds.get(entry.id);
            if (!owned) {
              owned = new Set<string>();
              loadedIds.set(entry.id, owned);
            }
            for (const rid of after) {
              if (!before.has(rid)) owned.add(rid);
            }
            // Lifecycle hook (spec §5.1): a runtime extension bundle just loaded —
            // observers see it after registration, before first render.
            void fireHooks("extension.loaded", { id: entry.id, url: entry.url });
          } catch {
            // Bundle failed to load/execute — left unrecorded so a later sync
            // retries (e.g. after the extension finishes writing its files).
          }
        }
      }
    }

    // DOM stratum (spec §7): same manifest, same SSE push — a `dom.ts` edit
    // moves its `?v=`, which changes the manifest JSON and fires the push.
    if (typeof entry.domUrl === "string") {
      domNow.add(entry.id);
      await syncDomEntry(entry.id, entry.domUrl);
    }
  }

  // Stale = loaded but no longer in this sync's enabled set (removed from
  // the server, or newly paused via manifest `disabled: true`). Unregister
  // exactly the id delta each folder added (fallback [id] when it added
  // nothing new) + forget so a later re-enable imports fresh.
  const toRemove = new Set<string>();
  for (const id of loaded.keys()) {
    if (!enabledNow.has(id)) {
      const owned = loadedIds.get(id);
      if (owned && owned.size > 0) {
        for (const rid of owned) toRemove.add(rid);
      } else {
        toRemove.add(id);
      }
      loaded.delete(id);
      loadedIds.delete(id);
    }
  }
  if (toRemove.size > 0) unregisterIds([...toRemove]);

  // Gating for glob-owned copies: a disabled id the runtime never loaded
  // (shipped via the Vite glob) still has a live registry entry — unregister
  // it so `disabled: true` actually pauses shipped extensions. No-op when
  // nothing is registered under those ids (unregisterIds only notifies on
  // removal). Stale runtime copies were already unregistered above; calling
  // again with the same ids is harmless.
  if (disabledNow.size > 0) unregisterIds([...disabledNow]);

  // Stale DOM = mounted but no longer shipped with a domUrl (removed,
  // paused, or the `dom.ts` was deleted while `index.tsx` stayed). Dispose
  // with the module's own `dispose` so no foreign node survives.
  for (const [id, prev] of loadedDom) {
    if (!domNow.has(id)) {
      loadedDom.delete(id);
      disposeDomExtension(id, prev.module);
    }
  }
}

/**
 * Mount one DOM-stratum bundle, no-op when THIS domUrl is already mounted.
 * A moved `?v=` disposes the old module (its own `dispose` runs) before
 * mounting the new one — hot edits repaint clean, never stack ghosts.
 * Import/shape failures stay unrecorded so the next sync retries.
 */
async function syncDomEntry(id: string, domUrl: string): Promise<void> {
  if (loadedDom.get(id)?.url === domUrl) return;
  let module: DomExtensionModule;
  try {
    const imported = (await import(/* @vite-ignore */ domUrl)) as { default?: unknown };
    if (!isDomExtensionModule(imported.default)) return;
    module = imported.default;
  } catch {
    return;
  }
  const prev = loadedDom.get(id);
  if (prev) disposeDomExtension(id, prev.module);
  loadedDom.set(id, { url: domUrl, module });
  await mountDomExtension(id, module);
}

/** Subscribe to the proxy's manifest push channel; EventSource reconnects. */
function subscribeManifestPush(): void {
  let source: EventSource | null = null;
  try {
    source = new EventSource("/api/webui/extensions/events");
  } catch {
    return;
  }
  source.onmessage = () => {
    void syncOnce({ force: true });
  };
  source.onerror = () => {
    // EventSource backs off and reconnects on its own; if the stream is
    // down for good the visibility refetch below still catches up.
  };
  // A stream that died while the tab was hidden replays nothing — refetch
  // explicitly when the tab becomes visible again.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void syncOnce();
  });
}

/** Kicks off the manifest sync (immediately) then follows SSE pushes.
 * Idempotent. */
export function startRuntimeExtensions(): void {
  if (started) return;
  started = true;
  ensureBridge();
  void syncOnce({ force: true }); // boot sync: unconditional
  subscribeManifestPush();
}
