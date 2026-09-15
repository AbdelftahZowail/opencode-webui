/**
 * Frecency scoring — frequency weighted by recency, ported from the v2 TUI
 * (`packages/tui/src/prompt/frecency.tsx`). The `@`-mention picker is the
 * consumer.
 *
 * PURE: no DOM, no localStorage, no React, and deliberately no import from
 * `store.ts`. It takes usage records (`FrecencyData`) and returns plain
 * values; persistence and event recording are the caller's job (the store
 * wires `recordUsage`, the proxy/caller persists the returned object).
 */

/** v2's cap (`MAX_FRECENCY_ENTRIES` in `prompt/frecency.tsx`). */
export const MAX_FRECENCY_ENTRIES = 1000;

export interface FrecencyEntry {
  path: string;
  frequency: number;
  lastOpen: number;
}

export type FrecencyData = Record<string, FrecencyEntry>;

/**
 * v2's formula, verbatim: `frequency / (1 + ageInDays)`, where
 * `ageInDays = (now - lastOpen) / 86_400_000`. A missing entry scores 0.
 *
 * `now` is injectable so the function is unit-testable; production callers
 * omit it and get `Date.now()`.
 */
export function frecencyScore(entry?: FrecencyEntry, now: number = Date.now()): number {
  if (!entry) return 0;
  return entry.frequency / (1 + (now - entry.lastOpen) / 86_400_000);
}

/**
 * Rank `items` by frecency, highest score first.
 *
 * v2 does not sort by frecency outright — it multiplies its fuzzy-match score
 * by `(1 + frecencyScore)`, so an unknown path is left at its base rank
 * instead of being dropped. There is no fuzzy stage here, so the v2-faithful
 * mapping is: scored paths sort by score, and UNKNOWN paths (no record →
 * score 0) keep their incoming relative order at the END. The `index`
 * tiebreak makes the sort stable for equal scores.
 */
export function rankByFrecency<T>(
  items: T[],
  pathOf: (item: T) => string,
  data: FrecencyData,
  now: number = Date.now(),
): T[] {
  return items
    .map((item, index) => ({ item, index, score: frecencyScore(data[pathOf(item)], now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item);
}

/**
 * Pure increment: copy `data`, bump `path`'s frequency and stamp `lastOpen`
 * at `now`, then cap to the `MAX_FRECENCY_ENTRIES` most recent. Empty paths
 * are ignored; the input object is never mutated.
 */
export function recordUsage(data: FrecencyData, path: string, now: number = Date.now()): FrecencyData {
  if (!path) return data;
  const prev = data[path];
  const next: FrecencyData = {
    ...data,
    [path]: { path, frequency: (prev?.frequency ?? 0) + 1, lastOpen: now },
  };
  return pruneFrecency(next);
}

/**
 * Keep only the `MAX_FRECENCY_ENTRIES` entries with the newest `lastOpen`
 * (v2's prune: `sort by lastOpen desc → slice(0, MAX)`). Returns the input
 * unchanged when already within the cap.
 */
export function pruneFrecency(data: FrecencyData): FrecencyData {
  const entries = Object.values(data);
  if (entries.length <= MAX_FRECENCY_ENTRIES) return data;
  const kept = entries
    .sort((a, b) => b.lastOpen - a.lastOpen)
    .slice(0, MAX_FRECENCY_ENTRIES);
  return Object.fromEntries(kept.map((entry) => [entry.path, entry]));
}
