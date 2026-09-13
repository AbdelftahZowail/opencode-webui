/**
 * Sidebar visibility memory — tiny, persisted, view-only.
 *
 * A session that has been active (running or queued) stays in its workspace's
 * default-visible slice until the user opens it once; after that a finished
 * session may drop below the fold and be reached with "Show more". Marking it
 * opened again whenever it is idle AND focused means finishing while you watch
 * it never leaves a stale "keep visible" flag behind.
 *
 * This is presentation state, not engine state, so it lives beside the
 * sidebar rather than in the store.
 */
const KEY = "webui.sessionActivity";
/** Ignore writes closer than this — active tracking ticks on every poll. */
const THROTTLE_MS = 4_000;
/** Cap each map so localStorage cannot grow without bound. */
const MAX_IDS = 400;

interface ActivityMemory {
  /** session id -> last time it was observed running/queued. */
  active: Record<string, number>;
  /** session id -> last time the user viewed it while idle. */
  opened: Record<string, number>;
}

let cache: ActivityMemory | null = null;

function load(): ActivityMemory {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ActivityMemory>) : null;
    cache = {
      active: parsed?.active && typeof parsed.active === "object" ? parsed.active : {},
      opened: parsed?.opened && typeof parsed.opened === "object" ? parsed.opened : {},
    };
  } catch {
    cache = { active: {}, opened: {} };
  }
  return cache;
}

let lastWrite = 0;
function persist(): void {
  const now = Date.now();
  if (now - lastWrite < THROTTLE_MS) return;
  lastWrite = now;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode — memory still works for this tab */
  }
}

function prune(map: Record<string, number>): void {
  const ids = Object.keys(map);
  if (ids.length <= MAX_IDS) return;
  ids.sort((a, b) => map[a]! - map[b]!);
  for (const id of ids.slice(0, ids.length - MAX_IDS)) delete map[id];
}

/** Record that a session just ran/was queued. */
export function markSessionActive(id: string): void {
  const mem = load();
  const now = Date.now();
  if (now - (mem.active[id] ?? 0) < THROTTLE_MS) return;
  mem.active[id] = now;
  prune(mem.active);
  persist();
}

/** Record that the user is looking at an idle session. */
export function markSessionOpened(id: string): void {
  const mem = load();
  const now = Date.now();
  if (now - (mem.opened[id] ?? 0) < THROTTLE_MS) return;
  mem.opened[id] = now;
  prune(mem.opened);
  persist();
}

/**
 * True when the row should stay visible regardless of the newest-N slice:
 * it was active and has not been viewed since (opened wins only when newer).
 */
export function isSessionSticky(id: string): boolean {
  const mem = load();
  const active = mem.active[id];
  if (!active) return false;
  const opened = mem.opened[id];
  return !opened || opened < active;
}
