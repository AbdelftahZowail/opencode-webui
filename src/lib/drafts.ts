/**
 * Per-session unsent composer text ("drafts"), localStorage-backed so a
 * half-typed message survives session switches AND full page reloads. No
 * UI surface — the composer restores it silently and clears it on send.
 */

const STORAGE_KEY = "webui.drafts";
/** Cap the map so abandoned one-word drafts can't grow without bound. */
const MAX_DRAFTS = 50;

interface DraftEntry {
  text: string;
  at: number;
}

type DraftMap = Record<string, DraftEntry>;

function load(): DraftMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DraftMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(map: DraftMap): void {
  try {
    // Keep only the most recently touched entries.
    const kept = Object.entries(map)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_DRAFTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable (private mode/quota) — drafts just don't persist */
  }
}

export function loadDraft(sessionID: string): string {
  return load()[sessionID]?.text ?? "";
}

export function saveDraft(sessionID: string, text: string): void {
  const map = load();
  if (!text) {
    if (!(sessionID in map)) return;
    delete map[sessionID];
  } else {
    map[sessionID] = { text, at: Date.now() };
  }
  write(map);
}
