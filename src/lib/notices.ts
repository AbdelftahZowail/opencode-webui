/**
 * Product-notice helpers — pure rules + a tiny persisted de-dup.
 *
 * Kept out of the components so "which announcement is worth showing?" and
 * "has it been dismissed?" are testable without a DOM. The rendering lives in
 * `UpdateNotice.tsx`, on the same `update.notice` surface as the app-update
 * notice (one notice surface, one method).
 *
 * Dismissal is localStorage-only (private-mode safe): this is deliberately NOT
 * the prefs system, matching `lib/updateNotice.ts`'s `dismissedVersion`.
 */
import type { WebuiAnnouncement, WebuiRelease } from "../api/client";

/** Lower sorts first: a security message outranks everything else. */
const PRIORITY: Record<WebuiAnnouncement["level"], number> = {
  security: 0,
  warning: 1,
  info: 2,
};

export const DISMISSED_ANNOUNCEMENTS_KEY = "webui.notices.dismissedAnnouncements";
/** Cap the remembered ids so the key cannot grow without bound. */
export const MAX_DISMISSED = 50;

export function getDismissedAnnouncementIds(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw: unknown = JSON.parse(localStorage.getItem(DISMISSED_ANNOUNCEMENTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Record one announcement as dismissed; returns the new id list. */
export function dismissAnnouncement(id: number | string): string[] {
  const next = [
    ...getDismissedAnnouncementIds().filter((x) => x !== String(id)),
    String(id),
  ].slice(-MAX_DISMISSED);
  try {
    localStorage.setItem(DISMISSED_ANNOUNCEMENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota */
  }
  return next;
}

export function isAnnouncementDismissed(id: number | string, dismissedIds: string[]): boolean {
  return dismissedIds.includes(String(id));
}

/**
 * The single announcement worth surfacing: highest severity, then newest.
 * Dismissed ids are skipped so dismissing one reveals the next.
 */
export function pickAnnouncement(
  announcements: WebuiAnnouncement[],
  dismissedIds: string[],
): WebuiAnnouncement | null {
  const live = announcements.filter((a) => !isAnnouncementDismissed(a.id, dismissedIds));
  if (live.length === 0) return null;
  const sorted = live.slice().sort((a, b) => {
    const byPriority = PRIORITY[a.level] - PRIORITY[b.level];
    if (byPriority !== 0) return byPriority;
    return (b.published_at ?? "").localeCompare(a.published_at ?? "");
  });
  return sorted[0] ?? null;
}

/** The release note matching an offered version name, tolerating a `v` prefix. */
export function matchingRelease(
  versions: WebuiRelease[],
  version: string | null | undefined,
): WebuiRelease | null {
  if (!version) return null;
  const want = version.replace(/^v/, "");
  return versions.find((r) => (r.name ?? "").replace(/^v/, "") === want) ?? null;
}

/** Trim a release body for the compact, collapsed notice (plain text). */
export function summarizeRelease(body: string | undefined, max = 800): string {
  const text = (body ?? "").replace(/\r/g, "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Newest-first ordering for a hub feed list (announcements or release notes) —
 * the order the permanent Settings › About lists render in. The hub generally
 * returns newest-first already, but that is not part of the documented
 * contract, so the list surface sorts explicitly. A stable sort: rows with an
 * equal (or missing) `published_at` keep their feed order.
 */
export function sortNewestFirst<T extends { published_at?: string | null }>(
  list: readonly T[],
): T[] {
  return list
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (b.item.published_at ?? "").localeCompare(a.item.published_at ?? "") ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}
