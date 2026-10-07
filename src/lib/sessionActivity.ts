/**
 * Unread ("new") memory for session rows — tiny, persisted, cross-tab.
 *
 * The rule is engine-driven, never observation-driven: a session is UNREAD
 * when the engine's last write (`time.updated`) is newer than the last moment
 * the user had it open (`opened`). That makes the badge deterministic —
 * identical in every tab, on a cold start, and after a reload — instead of
 * depending on whether some tab happened to be polling while the run was in
 * flight (the old "it comes and goes and I don't know why" behaviour).
 *
 * Supporting decisions:
 * - Viewing IS reading. Focusing a session stamps `opened`, including the
 *   moment a run you were watching goes idle, so a run you watched start to
 *   finish never badges afterwards. That is also why the stamp throttle is
 *   bounded by the settle slop — see `STAMP_THROTTLE_MS`.
 * - `SETTLE_SLOP_MS` absorbs the window where the session list refreshes a
 *   beat after the store settled and reports a slightly newer `updated`.
 * - `UNSEEN_TTL_MS` stops long-dead sessions from nagging forever.
 * - The first list we ever see is BASELINED as read, so installing this does
 *   not paint the whole sidebar yellow on day one.
 * - Writes broadcast (BroadcastChannel, plus the `storage` event as a
 *   fallback) and this module is subscribable, so opening a session in one
 *   tab clears the badge in ALL tabs with no refresh.
 *
 * This is presentation state, not engine state, so it lives beside the
 * sidebar rather than in the store.
 */
import { useSyncExternalStore } from "react";

const KEY = "webui.sessionActivity";
const CHANNEL = "webui.sessionActivity";
/**
 * Ignore re-stamps of the SAME session inside this window.
 *
 * This MUST stay below `SETTLE_SLOP_MS`, and that is a correctness coupling
 * rather than a tuning knob: a stamp is dropped only while
 * `now - opened` is under this window, while a badge only appears once
 * `updated` passes `opened + SETTLE_SLOP_MS`. With the window under the slop,
 * a dropped stamp can never coincide with one that would have badged — which
 * is what keeps a run you watched start-to-finish from badging afterwards.
 *
 * (It used to be 4s against a 2s slop, so a run finishing 2-4s after you
 * focused the session had its read stamp discarded and then badged anyway.)
 */
const STAMP_THROTTLE_MS = 1_000;
/** localStorage write + broadcast throttle ONLY — memory is always exact. */
const PERSIST_THROTTLE_MS = 1_000;
/** Cap the map so localStorage cannot grow without bound. */
const MAX_IDS = 400;
/** Output older than this stops badging. */
const UNSEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The session list settles a beat after a run ends — never badge that gap. */
const SETTLE_SLOP_MS = 2_000;

interface OpenedMemory {
  /** session id -> epoch ms when the user last had it open. */
  opened: Record<string, number>;
  /** Epoch ms of the first-ever baseline, or absent while unbaselined. */
  baselined?: number;
}

let cache: OpenedMemory | null = null;

/** Bumped on every visible change; the stable snapshot React subscribes to. */
let version = 0;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let wired = false;
let lastWrite = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function parse(raw: string | null): OpenedMemory {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<OpenedMemory>) : null;
    return {
      opened: parsed?.opened && typeof parsed.opened === "object" ? parsed.opened : {},
      baselined: typeof parsed?.baselined === "number" ? parsed.baselined : undefined,
    };
  } catch {
    return { opened: {}, baselined: undefined };
  }
}

function load(): OpenedMemory {
  if (cache) return cache;
  cache = parse(safeRead());
  return cache;
}

function safeRead(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function notify(): void {
  version++;
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  ensureWired();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Stable snapshot for `useSyncExternalStore` — a plain counter. */
function getVersion(): number {
  return version;
}

function prune(map: Record<string, number>): void {
  const ids = Object.keys(map);
  if (ids.length <= MAX_IDS) return;
  ids.sort((a, b) => map[a]! - map[b]!);
  for (const id of ids.slice(0, ids.length - MAX_IDS)) delete map[id];
}

/** Coalesce the localStorage write + the broadcast into one tick. */
function schedulePersist(): void {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, PERSIST_THROTTLE_MS);
}

function persist(): void {
  // A writer must be able to announce itself even if nothing in THIS tab
  // subscribes yet — otherwise a read recorded before the first subscriber
  // mounts would never reach its peers.
  ensureWired();
  const mem = load();
  // Throttle the WRITE only. The in-memory map above is always exact, so a
  // dropped write can never make the badge flip in this tab — it only delays
  // the cross-tab broadcast until the next real change.
  const now = Date.now();
  if (now - lastWrite < PERSIST_THROTTLE_MS) {
    schedulePersist();
    return;
  }
  lastWrite = now;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(mem));
  } catch {
    /* private mode — memory still works for this tab */
  }
  // Peers merge by max-per-key, so a redundant broadcast is a no-op for them.
  try {
    channel?.postMessage(mem);
  } catch {
    /* channel closed */
  }
}

/**
 * Merge a peer's memory in. Per key we keep the NEWEST stamp, which makes
 * delivery idempotent and order-insensitive — late or duplicated messages
 * (BroadcastChannel AND the storage event both fire) change nothing.
 */
function applyRemote(remote: OpenedMemory | null): void {
  if (!remote) return;
  const mem = load();
  let changed = false;
  for (const [id, at] of Object.entries(remote.opened ?? {})) {
    if (typeof at !== "number") continue;
    if (at > (mem.opened[id] ?? 0)) {
      mem.opened[id] = at;
      changed = true;
    }
  }
  if (typeof remote.baselined === "number" && !mem.baselined) {
    mem.baselined = remote.baselined;
    changed = true;
  }
  if (!changed) return;
  prune(mem.opened);
  notify();
  // Re-persisting merges our newer keys into the shared blob for the next
  // cold start; the storage event this triggers is a no-op in peers.
  schedulePersist();
}

function ensureWired(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL);
      channel.addEventListener("message", (event: MessageEvent) => {
        applyRemote(event.data as OpenedMemory | null);
      });
    }
  } catch {
    channel = null;
  }
  // Fallback (and belt-and-braces): fires in every OTHER tab on write, and
  // covers peers whose BroadcastChannel construction failed. Idempotent, so
  // the double delivery when both work costs one no-op comparison.
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== KEY) return;
    applyRemote(parse(event.newValue));
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record that the user is looking at a session — the single "I've read it"
 * signal, shared with every other tab. Called when a session gains focus and
 * when a run the user was watching goes idle.
 */
export function markSessionOpened(id: string): void {
  if (!id) return;
  const mem = load();
  const now = Date.now();
  if (now - (mem.opened[id] ?? 0) < STAMP_THROTTLE_MS) return;
  mem.opened[id] = now;
  prune(mem.opened);
  notify();
  // Reads are rare and are exactly the cross-tab event people care about
  // ("opened here, cleared there"), so announce it without the write throttle.
  lastWrite = 0;
  persist();
}

/**
 * First-run migration: adopt the session list we are looking at as ALREADY
 * READ, so upgrading doesn't mark every existing session unread. No-ops once
 * a baseline exists, so it is safe to call on every list refresh.
 */
export function baselineOpened(ids: readonly string[]): void {
  const mem = load();
  if (mem.baselined) return;
  const now = Date.now();
  mem.baselined = now;
  for (const id of ids) if (id) mem.opened[id] = now;
  prune(mem.opened);
  notify();
  lastWrite = 0;
  persist();
}

/**
 * Drop all read memory and re-baseline from scratch.
 *
 * Exported for tests and a future Settings › App control — nothing in core
 * calls it yet. Note the limit before wiring one up: the broadcast below
 * cannot CLEAR a peer, because `applyRemote` merges max-per-key and an absent
 * key carries no "unread" stamp. Peers only pick up the reset on their next
 * cold start (their `cache` still holds the old map), so a real cross-tab
 * reset needs an explicit generation counter in the payload.
 */
export function resetOpenedMemory(): void {
  cache = { opened: {}, baselined: Date.now() };
  version++;
  for (const cb of listeners) cb();
  lastWrite = 0;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  try {
    channel?.postMessage(cache);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * True when the session has output the user has not seen since last opening
 * it. Pure — the caller supplies the engine's `time.updated`.
 */
export function isSessionUnseen(id: string, updated: number): boolean {
  if (!id || !updated) return false;
  const opened = load().opened[id] ?? 0;
  if (updated <= opened + SETTLE_SLOP_MS) return false;
  return Date.now() - updated <= UNSEEN_TTL_MS;
}

/**
 * Reactive `isSessionUnseen` for one row. Subscribing per row is cheap (one
 * Set entry) and keeps the sidebar's search results in agreement with the
 * session list without threading a prop through every call site.
 */
export function useSessionUnseen(id: string, updated: number): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return isSessionUnseen(id, updated);
}

/**
 * Reactive tick for components that DERIVE from many rows at once (the
 * sidebar's grouping and sort). Pair with `isSessionUnseen` in a memo whose
 * deps include the returned version.
 */
export function useActivityVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * Subscribe without React. Currently used by the sidebar and its tests only —
 * it is NOT on the extension bridge (`src/lib/extensionApi.ts` does not
 * re-export it), so an extension cannot reach read state yet.
 */
export function subscribeActivity(cb: () => void): () => void {
  return subscribe(cb);
}
