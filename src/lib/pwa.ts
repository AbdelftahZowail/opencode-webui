/**
 * PWA shell: service-worker registration, install-prompt capture, and the
 * live activity tile driver.
 *
 * The tile reuses the ActivityStrip's data path (running/queued/unfinished
 * live entries) but renders it as one silent, pinned notification owned by
 * the SW: the page posts text snapshots, the SW shows/closes. Tap opens the
 * most recently active session. Updates only flow while sessions are active
 * and the tile is enabled — idle clears it.
 */

import { getState, sessionHref, type LiveTool } from "../store";
import { registerPoller } from "./scheduler";

const TILE_PREF_KEY = "webui.liveTile";
const TILE_INTERVAL_MS = 1_500;
const TILE_MAX_ROWS = 4;

let swReg: ServiceWorkerRegistration | null = null;
let installPrompt: Event | null = null;
const installListeners = new Set<() => void>();

function emitInstall() {
  for (const fn of installListeners) fn();
}

export function onInstallAvailable(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

export function getInstallPrompt(): Event | null {
  return installPrompt;
}

export function consumeInstallPrompt(): Event | null {
  const p = installPrompt;
  installPrompt = null;
  emitInstall();
  return p;
}

export function isStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

export function swSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    window.isSecureContext
  );
}

export function registerServiceWorker(): void {
  if (!swSupported()) return;
  // Capture the install prompt on ANY secure origin — dev included (Vite is
  // reached over localhost or Tailscale HTTPS). This listener used to sit after
  // the prod-only return below, so under `bun run dev` the app's own install UI
  // never saw beforeinstallprompt and reported "not installable".
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    emitInstall();
  });
  // A controlling service worker fights HMR — register it in prod only.
  if (!import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        swReg = reg;
      })
      .catch(() => {
        /* offline-first is best-effort; the app works without it */
      });
  });
}

export function tileEnabled(): boolean {
  try {
    return localStorage.getItem(TILE_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setTileEnabled(on: boolean): void {
  try {
    localStorage.setItem(TILE_PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode — tile just won't persist */
  }
  if (!on) void clearTile();
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

async function postToSw(msg: unknown): Promise<void> {
  try {
    const reg = swReg ?? (await navigator.serviceWorker.ready);
    swReg = reg;
    reg.active?.postMessage(msg);
  } catch {
    /* SW not ready — next tick retries */
  }
}

function clearTile(): Promise<void> {
  return postToSw({ type: "webui.tile.clear" });
}

function compactToolLabel(tool: LiveTool): string {
  const name = tool.name || "tool";
  const input = tool.input as Record<string, unknown> | undefined;
  if (input) {
    if (typeof input.path === "string") return `${name} ${String(input.path).split("/").pop()}`;
    if (typeof input.command === "string") return `${name} ${String(input.command).slice(0, 40)}`;
    if (typeof input.description === "string") return `${name} ${String(input.description).slice(0, 40)}`;
  }
  return name;
}

interface TileSnapshot {
  key: string;
  title: string;
  body: string;
  url: string;
}

function snapshotTile(): TileSnapshot | null {
  const s = getState();
  const liveBySession = new Map<string, { title: string; updated: number; rows: string[] }>();
  for (const a of s.live) {
    if (a.finish !== undefined) continue;
    const info = s.sessions.find((x) => x.id === a.sessionID);
    const entry = liveBySession.get(a.sessionID) ?? {
      title: info?.title || "Untitled session",
      updated: info?.time?.updated ?? a.started,
      rows: [],
    };
    for (const p of a.content) {
      if (p.type !== "tool") continue;
      const st = p.tool.status;
      if (st === "running" || st === "streaming" || st === "error") {
        entry.rows.push(`${st === "error" ? "✗" : "●"} ${compactToolLabel(p.tool)}`);
      }
    }
    liveBySession.set(a.sessionID, entry);
  }
  for (const [id, entry] of liveBySession) {
    if (entry.rows.length === 0) entry.rows.push(s.running[id] ? "● working…" : "○ queued");
  }
  // Sessions flagged running/queued but with no live entry yet (cold start).
  for (const id of [...Object.keys(s.running), ...Object.keys(s.queued)]) {
    if (liveBySession.has(id)) continue;
    const info = s.sessions.find((x) => x.id === id);
    liveBySession.set(id, {
      title: info?.title || "Untitled session",
      updated: info?.time?.updated ?? Date.now(),
      rows: [s.running[id] ? "● starting…" : "○ queued"],
    });
  }
  if (liveBySession.size === 0) return null;

  const groups = [...liveBySession.entries()].sort((a, b) => b[1].updated - a[1].updated);
  const n = groups.length;
  const lines: string[] = [];
  for (const [, g] of groups.slice(0, TILE_MAX_ROWS)) {
    lines.push(`${g.title.slice(0, 40)} — ${g.rows[g.rows.length - 1]}`);
  }
  if (n > TILE_MAX_ROWS) lines.push(`+${n - TILE_MAX_ROWS} more`);
  const latest = groups[0]!;
  return {
    key: `${n}|${lines.join("\n")}`,
    title: `${n} active · streaming`,
    body: lines.join("\n"),
    url: sessionHref(latest[0]),
  };
}

let lastKey = "";

export function startLiveTile(): void {
  registerPoller({
    name: "live-tile",
    minInterval: TILE_INTERVAL_MS,
    run: () => {
      if (!tileEnabled() || notificationPermission() !== "granted" || !swSupported()) {
        if (lastKey) {
          lastKey = "";
          void clearTile();
        }
        return;
      }
      const snap = snapshotTile();
      if (!snap) {
        if (lastKey) {
          lastKey = "";
          void clearTile();
        }
        return;
      }
      if (snap.key === lastKey) return;
      lastKey = snap.key;
      void postToSw({ type: "webui.tile", title: snap.title, body: snap.body, url: snap.url });
    },
  });
}
