/**
 * Product notices — the hub's **version** and **announcement** feeds, proxied.
 *
 * The browser never talks to the hub directly (CORS, and we want one cached
 * read for every tab). This module does a small, cached, FAIL-OPEN read of:
 *
 *   GET {hub}/v1/versions?product=opencode-webui       (release notes / What's New)
 *   GET {hub}/v1/announcements?product=opencode-webui  (ad-hoc product messages)
 *
 * Both are **public** reads: no key is sent, and the only thing that leaves the
 * machine is the constant `product=opencode-webui` in the URL. Nothing about
 * this install is transmitted — this is not telemetry, and it is deliberately
 * not gated on the telemetry opt-out: a security announcement must reach a user
 * who has telemetry off.
 *
 * Fail-open: an unreachable or erroring hub yields the last good copy (or an
 * empty, `unavailable` result) **per feed** — one feed's blip never blanks the
 * other, and a partial read keeps the last good rows. Boot never touches the
 * hub; a `/api/webui/notices` request on a cache miss waits for the (8s-capped)
 * read. Every forwarded field is validated, length-capped AND row-capped before
 * it reaches the page.
 */
import { PRODUCT, telemetryUrl } from "./telemetry";

/** How long one fetched copy is served. Announcements are ad-hoc; 6h is a
 * reasonable balance between freshness and politeness to the hub. */
export const NOTICES_CACHE_MS = 6 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 8_000;
/** Cap on a release note / announcement body forwarded to the page. */
export const MAX_BODY_CHARS = 4_000;
/** Cap on rows forwarded per feed (an over-long feed cannot bloat the page). */
export const MAX_ROWS = 50;
/** Cap on a forwarded ISO date string. */
export const MAX_DATE_CHARS = 64;

export type AnnouncementLevel = "info" | "warning" | "security";

export interface HubAnnouncement {
  id: number;
  title: string;
  body: string;
  level: AnnouncementLevel;
  product: string;
  published_at: string | null;
  expires_at: string | null;
}

export interface HubRelease {
  name: string;
  tag: string;
  title: string;
  body: string;
  published_at: string | null;
  prerelease: boolean;
  security: boolean;
}

export interface WebuiNotices {
  announcements: HubAnnouncement[];
  versions: HubRelease[];
  /** True when this copy could not be refreshed from the hub. */
  unavailable: boolean;
  /** When this copy was fetched from the hub, ISO, or null if never. */
  fetchedAt: string | null;
}

const EMPTY: WebuiNotices = { announcements: [], versions: [], unavailable: true, fetchedAt: null };

let cache: { at: number; data: WebuiNotices } | null = null;

function hubUrl(): string {
  return telemetryUrl().trim().replace(/\/+$/, "");
}

function asString(value: unknown, max = MAX_BODY_CHARS): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function asLevel(value: unknown): AnnouncementLevel {
  return value === "warning" || value === "security" ? value : "info";
}

function asDate(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_DATE_CHARS) : null;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Trim/validate an untrusted feed payload down to the shape the page expects. */
export function sanitizeAnnouncements(raw: unknown): HubAnnouncement[] {
  const list = (raw as { announcements?: unknown } | null)?.announcements;
  if (!Array.isArray(list)) return [];
  const out: HubAnnouncement[] = [];
  for (const item of list) {
    if (out.length >= MAX_ROWS) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number" || !Number.isFinite(row.id)) continue;
    out.push({
      id: row.id,
      title: asString(row.title, 200),
      body: asString(row.body),
      level: asLevel(row.level),
      product: asString(row.product, 32),
      published_at: asDate(row.published_at),
      expires_at: asDate(row.expires_at),
    });
  }
  return out;
}

export function sanitizeVersions(raw: unknown): HubRelease[] {
  const list = (raw as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(list)) return [];
  const out: HubRelease[] = [];
  for (const item of list) {
    if (out.length >= MAX_ROWS) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = asString(row.name, 64);
    if (!name) continue;
    out.push({
      name,
      tag: asString(row.tag, 64),
      title: asString(row.title, 300),
      body: asString(row.body),
      published_at: asDate(row.published_at),
      prerelease: row.prerelease === true,
      security: row.security === true,
    });
  }
  return out;
}

/**
 * Return the cached notices, refreshing when stale. Never throws.
 *
 * `now` and the fetcher are injectable for tests.
 */
export async function getNotices(
  opts: { force?: boolean; now?: number } = {},
): Promise<WebuiNotices> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && now - cache.at < NOTICES_CACHE_MS) return cache.data;

  const base = hubUrl();
  if (!base) return cache?.data ?? EMPTY;

  // One feed failing must not blank the other — see the merge below.
  const [annRaw, verRaw] = await Promise.all([
    fetchJson(`${base}/v1/announcements?product=${encodeURIComponent(PRODUCT)}`),
    fetchJson(`${base}/v1/versions?product=${encodeURIComponent(PRODUCT)}`),
  ]);

  // A partial failure keeps the last good copy for the FAILED feed: one blip
  // must not blank the other, and a security announcement must survive a
  // transient error on the versions feed (and vice versa).
  const annFailed = annRaw === null;
  const verFailed = verRaw === null;
  if (annFailed && verFailed) {
    // Total failure: keep serving the last good copy, flagged stale.
    return cache ? { ...cache.data, unavailable: true } : EMPTY;
  }

  const data: WebuiNotices = {
    announcements: annFailed ? (cache?.data.announcements ?? []) : sanitizeAnnouncements(annRaw),
    versions: verFailed ? (cache?.data.versions ?? []) : sanitizeVersions(verRaw),
    unavailable: annFailed || verFailed,
    fetchedAt: new Date(now).toISOString(),
  };
  // Only a fully-fresh copy is cached; a partial one is retried on the next call
  // rather than pinned for the full TTL.
  if (!data.unavailable) cache = { at: now, data };
  return data;
}

/** Testing/CI only: drop the in-memory copy. */
export function __resetNoticesCache(): void {
  cache = null;
}
