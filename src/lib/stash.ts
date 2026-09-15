/**
 * Prompt stash — a small localStorage-backed stack of parked composer
 * prompts, ported from the v2 TUI (`packages/tui/src/prompt/stash.tsx`).
 *
 * v2 persists a `PromptInfo` per entry; the webui composer is plain text, so
 * an entry here is just `{ text, timestamp }` (a deliberate simplification).
 * Behaviour is otherwise v2-faithful: append on push, trim to the newest
 * `MAX_STASH_ENTRIES`, pop the NEWEST entry, remove by index.
 *
 * Persistence follows the existing `src/lib/drafts.ts` pattern: one
 * localStorage key, JSON parse with a shape guard, write-through, a cap, and
 * no subscription/event bus. Every mutator returns the new list so callers
 * re-render without re-reading. Storage access is wrapped so a private-mode /
 * quota failure degrades to "doesn't persist" instead of throwing.
 */

const STORAGE_KEY = "webui.promptStash";

/** v2's cap (`MAX_STASH_ENTRIES` in `prompt/stash.tsx`). */
export const MAX_STASH_ENTRIES = 50;

export interface StashEntry {
  text: string;
  timestamp: number;
}

/** Shape guard for untrusted JSON — drops anything that isn't an entry. */
function isStashEntry(value: unknown): value is StashEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.text === "string" && typeof entry.timestamp === "number";
}

/** Oldest → newest, capped. Never throws. */
function load(): StashEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStashEntry).slice(-MAX_STASH_ENTRIES);
  } catch {
    return [];
  }
}

function write(entries: StashEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_STASH_ENTRIES)));
  } catch {
    /* storage unavailable (private mode/quota) — the stash just doesn't persist */
  }
}

/** The stash as stored, oldest → newest (capped to `MAX_STASH_ENTRIES`). */
export function listStash(): StashEntry[] {
  return load();
}

/**
 * Append a prompt and trim to the cap. Empty text is a no-op (returns the
 * current list). Returns the new oldest → newest list.
 */
export function pushStash(text: string): StashEntry[] {
  const current = load();
  if (!text) return current;
  const next = [...current, { text, timestamp: Date.now() }].slice(-MAX_STASH_ENTRIES);
  write(next);
  return next;
}

/**
 * Remove and return the NEWEST entry (v2's `pop` takes the list tail).
 * `undefined` when the stash is empty.
 */
export function popStash(): StashEntry | undefined {
  const current = load();
  const entry = current[current.length - 1];
  if (!entry) return undefined;
  write(current.slice(0, -1));
  return entry;
}

/** Remove one entry by its oldest → newest index. Returns the new list. */
export function removeStash(index: number): StashEntry[] {
  const current = load();
  if (index < 0 || index >= current.length) return current;
  const next = [...current.slice(0, index), ...current.slice(index + 1)];
  write(next);
  return next;
}
