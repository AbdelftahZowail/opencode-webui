/* opencode-webui service worker: app-shell caching + live activity tile.
 *
 * - Navigations: network-first (updates always flow), cache fallback offline.
 * - Hashed /assets/* (immutable build output): cache-first.
 * - Everything else, in particular /api/* (SSE streams): never intercepted.
 * - Live tile: the page posts {type:"webui.tile",...} snapshots; the SW owns
 *   one silent, pinned notification. A watchdog closes it if the page stops
 *   reporting (dead tab must not leave a stale pinned tile).
 */

const TILE_TAG = "webui-activity";
const ASSET_CACHE = "webui-assets-v1";
const PAGE_CACHE = "webui-pages-v1";
const TILE_WATCHDOG_MS = 30_000;

let tileWatchdog = 0;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== ASSET_CACHE && k !== PAGE_CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isHashedAsset(url) {
  return url.origin === self.location.origin && /\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // streams + JSON: network only

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(PAGE_CACHE);
          cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(request);
          if (cached) return cached;
          const index = await caches.match("/index.html");
          if (index) return index;
          throw new Error("offline");
        }
      })(),
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        const cache = await caches.open(ASSET_CACHE);
        cache.put(request, fresh.clone());
        return fresh;
      })(),
    );
  }
});

async function closeTile() {
  const notes = await self.registration.getNotifications({ tag: TILE_TAG });
  await Promise.all(notes.map((n) => n.close()));
  if (tileWatchdog) {
    clearTimeout(tileWatchdog);
    tileWatchdog = 0;
  }
}

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "webui.tile.clear") {
    event.waitUntil(closeTile());
    return;
  }
  if (msg.type !== "webui.tile") return;
  const { title, body, url } = msg;
  if (typeof title !== "string" || typeof body !== "string") return;
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        tag: TILE_TAG,
        body,
        silent: true,
        ongoing: true,
        renotify: false,
        icon: "/icons/icon-192.png",
        // Small (status-bar) icon on Android: a MONOCHROME silhouette on a
        // transparent background. Chrome tints the alpha, so the old full-color
        // 192px icon rendered as a solid white square.
        badge: "/icons/badge-96.png",
        timestamp: Date.now(),
        data: { url: typeof url === "string" ? url : "/" },
      });
      if (tileWatchdog) clearTimeout(tileWatchdog);
      tileWatchdog = setTimeout(() => {
        tileWatchdog = 0;
        void closeTile();
      }, TILE_WATCHDOG_MS);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  const absolute = new URL(target, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const win of windows) {
        try {
          if (new URL(win.url).origin === self.location.origin) {
            await win.navigate(absolute);
            return win.focus();
          }
        } catch {
          /* cross-origin client — skip */
        }
      }
      return self.clients.openWindow(absolute);
    })(),
  );
});
