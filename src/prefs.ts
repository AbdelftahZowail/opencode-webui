/**
 * How often the transcript repaints while a run is streaming:
 *  - `full`    — every 16ms batch (token by token, TUI parity).
 *  - `relaxed` — at most every ~200ms; progressive text, far fewer renders.
 *  - `off`     — only when a part finishes (`*.ended`).
 * `full` is the default; the others exist for slow phones where per-token
 * re-renders (markdown parse + layout) make the UI feel janky.
 */
export type StreamMode = "full" | "relaxed" | "off";

export type Prefs = {
  showReasoning: boolean;
  showToolDetails: boolean;
  showTimestamps: boolean;
  streamMode: StreamMode;
};

const DEFAULTS: Prefs = {
  showReasoning: true,
  showToolDetails: true,
  showTimestamps: false,
  streamMode: "full",
};
const STORAGE_KEY = "webui.prefs";

export const STREAM_MODES: readonly StreamMode[] = ["full", "relaxed", "off"];

export const STREAM_MODE_SHORT: Record<StreamMode, string> = {
  full: "Full",
  relaxed: "Relaxed",
  off: "Off",
};

export const STREAM_MODE_DESC: Record<StreamMode, string> = {
  full: "Repaint on every token — smoothest text, most work.",
  relaxed: "Repaint ~5×/sec — progressive text, far less work.",
  off: "Repaint only when a part finishes — least work, text lands in chunks.",
};

/** Cycle full → relaxed → off → full (one control, no dropdown). */
export function nextStreamMode(mode: StreamMode): StreamMode {
  const i = STREAM_MODES.indexOf(mode);
  return STREAM_MODES[(i + 1) % STREAM_MODES.length]!;
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const merged: Prefs = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
    // Guard a hand-edited/garbage value; anything unknown falls back to full.
    if (!STREAM_MODES.includes(merged.streamMode)) merged.streamMode = "full";
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs: Prefs = load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return { ...prefs };
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  prefs = { ...prefs, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    void 0;
  }
  for (const fn of listeners) fn();
}

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
