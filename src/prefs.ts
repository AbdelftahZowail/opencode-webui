export type Prefs = { showReasoning: boolean; showToolDetails: boolean; showTimestamps: boolean };

const DEFAULTS: Prefs = { showReasoning: true, showToolDetails: true, showTimestamps: false };
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
