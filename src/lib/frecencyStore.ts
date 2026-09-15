/**
 * Persistence for the PURE frecency lib (`lib/frecency.ts`): the same
 * localStorage pattern as `lib/drafts.ts`, keyed per directory so a file's
 * score is scoped to the project it belongs to.
 *
 * Ordering happens in FilePicker before results render; recording happens
 * where a pick is observed. The pure lib owns the maths — this module owns
 * the storage, which is what keeps `frecency.ts` unit-testable.
 */

import {
  MAX_FRECENCY_ENTRIES,
  pruneFrecency,
  recordUsage,
  type FrecencyData,
} from "./frecency";

const STORAGE_KEY = "webui.frecency";
/** Cap the number of directories tracked so `@`-mentions in a hundred
 *  throwaway repos cannot grow storage without bound. */
const MAX_DIRECTORIES = 20;

type ByDirectory = Record<string, FrecencyData>;

/** Records are keyed by directory; an unresolved location uses this bucket. */
const NO_DIRECTORY = "";

function load(): ByDirectory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ByDirectory;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(map: ByDirectory): void {
  try {
    // Keep only the most recently touched directories (bounded storage).
    const kept = Object.entries(map)
      .sort((a, b) => latest(b[1]) - latest(a[1]))
      .slice(0, MAX_DIRECTORIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable (private mode/quota) — frecency just doesn't persist */
  }
}

function latest(data: FrecencyData): number {
  let newest = 0;
  for (const entry of Object.values(data)) {
    if (entry.lastOpen > newest) newest = entry.lastOpen;
  }
  return newest;
}

export function loadFrecency(directory: string | undefined): FrecencyData {
  const key = directory ?? NO_DIRECTORY;
  return load()[key] ?? {};
}

/** Record one file pick for a directory and persist the pruned result. */
export function recordFileUsage(directory: string | undefined, path: string): void {
  const key = directory ?? NO_DIRECTORY;
  const map = load();
  const next = pruneFrecency(recordUsage(map[key] ?? {}, path));
  const trimmed = Object.fromEntries(
    Object.entries(next)
      .sort((a, b) => b[1].lastOpen - a[1].lastOpen)
      .slice(0, MAX_FRECENCY_ENTRIES),
  );
  write({ ...map, [key]: trimmed });
}
