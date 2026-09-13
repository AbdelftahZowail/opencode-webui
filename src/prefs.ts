export type Prefs = {
  showReasoning: boolean;
  showToolDetails: boolean;
  showTimestamps: boolean;
  /**
   * Stream assistant text/reasoning/tool-input as it arrives. Default ON
   * (TUI parity). Turning it OFF keeps the same final output but repaints the
   * transcript only at part boundaries — the option for slow phones where
   * per-token re-renders make the UI feel janky.
   */
  streamLive: boolean;
};

const DEFAULTS: Prefs = {
  showReasoning: true,
  showToolDetails: true,
  showTimestamps: false,
  streamLive: true,
};
const STORAGE_KEY = "webui.prefs";

function load(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...parsed };
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
