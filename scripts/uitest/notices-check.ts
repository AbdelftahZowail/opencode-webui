#!/usr/bin/env bun
/**
 * Product-notice contract check — the proxy's hub read, the pure selection
 * rules, and the RENDERED notice card.
 *
 *   bun run check:notices
 *
 * Everything is offline: a local stub hub serves the two feeds, and the notice
 * component is rendered to static markup (no browser, no engine). This is the
 * guardrail for `server/notices.ts` + `src/lib/notices.ts` + the announcement
 * branch of `src/components/UpdateNotice.tsx`, mirroring `check:telemetry`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_BODY_CHARS,
  __resetNoticesCache,
  getNotices,
  sanitizeAnnouncements,
  sanitizeVersions,
} from "../../server/notices";
import { DEFAULT_TELEMETRY_URL, telemetryUrl } from "../../server/telemetry";
import {
  dismissAnnouncement,
  getDismissedAnnouncementIds,
  matchingRelease,
  pickAnnouncement,
  sortNewestFirst,
  summarizeRelease,
  DISMISSED_ANNOUNCEMENTS_KEY,
} from "../../src/lib/notices";
import type { WebuiAnnouncement } from "../../src/api/client";
import { UpdateNotice } from "../../src/components/UpdateNotice";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- a tiny localStorage mock (the lib is guarded, but we want persistence) --
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const saved = { WEBUI_TELEMETRY_URL: process.env.WEBUI_TELEMETRY_URL };

// ---------------------------------------------------------------------------
// 1. Happy path against a stubbed hub (real feed shape from the hub contract)
// ---------------------------------------------------------------------------
const seenUrls: string[] = [];
const hub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    seenUrls.push(url.pathname + url.search);
    if (url.pathname === "/v1/announcements") {
      return Response.json({
        product: "opencode-webui",
        announcements: [
          { id: 9, title: "Gmail incident resolved", body: "Sync is back.", level: "warning", product: "opencode-webui", published_at: "2026-10-15T00:00:00Z", expires_at: null },
          { id: 4, title: "Rotate token", body: "CVE fixed.", level: "security", product: "opencode-webui", published_at: "2026-10-16T00:00:00Z", expires_at: null },
        ],
      });
    }
    if (url.pathname === "/v1/versions") {
      return Response.json({
        source: "github", product: "opencode-webui", repo: "x/y",
        versions: [
          { name: "3.4.1", tag: "v3.4.1", title: "3.4.1", body: "Fixes the leak.\n<!-- security -->", published_at: "2026-10-16T00:00:00Z", prerelease: false, security: true },
          { name: "3.4.0", tag: "v3.4.0", title: "3.4.0", body: "Notes", published_at: "2026-10-01T00:00:00Z", prerelease: false, security: false },
        ],
      });
    }
    return new Response("nope", { status: 404 });
  },
});
process.env.WEBUI_TELEMETRY_URL = `http://127.0.0.1:${hub.port}`;

__resetNoticesCache();
const notices = await getNotices({ force: true });
check("hub feed is fetched, not flagged unavailable", notices.unavailable === false);
check("announcements are parsed", notices.announcements.length === 2 && notices.announcements[1]?.level === "security");
check("versions are parsed", notices.versions.length === 2 && notices.versions[0]?.name === "3.4.1");
check("both feeds are requested product-scoped", seenUrls.length === 2 && seenUrls.every((u) => u.includes("product=opencode-webui")), seenUrls.join(","));
check("fetchedAt is stamped", typeof notices.fetchedAt === "string" && notices.fetchedAt.length > 0);

// cache: a second call must NOT hit the stub again
const before = seenUrls.length;
await getNotices();
check("a fresh copy is served from cache (no second fetch)", seenUrls.length === before);

// ---------------------------------------------------------------------------
// 2. Fail-soft: hub unreachable
// ---------------------------------------------------------------------------
hub.stop(true);
__resetNoticesCache();
process.env.WEBUI_TELEMETRY_URL = "http://127.0.0.1:1";
const soft = await getNotices({ force: true });
check(
  "unreachable hub resolves with a notices shape (does not throw)",
  "announcements" in soft && "versions" in soft && "unavailable" in soft && soft.fetchedAt === null,
);
check("unreachable hub yields empty + unavailable", soft.unavailable === true && soft.announcements.length === 0 && soft.versions.length === 0);
process.env.WEBUI_TELEMETRY_URL = "";
__resetNoticesCache();
// An unset URL is NOT "no hub": the module reuses the baked default hub base
// (public reads, no key). Only URL emptiness yields the empty-unavailable path,
// and the base is never empty. No network here.
check(
  "notices reuse the baked default hub base when unset",
  telemetryUrl() === DEFAULT_TELEMETRY_URL && /^https:/.test(DEFAULT_TELEMETRY_URL),
);
check("the resolved hub base is never empty", telemetryUrl().length > 0);

// ---------------------------------------------------------------------------
// 2b. Partial failure: one feed blips — the last good rows survive, per feed
// ---------------------------------------------------------------------------
__resetNoticesCache();
const good = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/announcements") {
      return Response.json({ announcements: [
        { id: 77, title: "Security notice", body: "Keep me.", level: "security", product: "opencode-webui", published_at: "2026-10-17T00:00:00Z", expires_at: null },
      ] });
    }
    return Response.json({ versions: [{ name: "3.4.0", tag: "v3.4.0", title: "3.4.0", body: "Notes", published_at: "2026-10-17T00:00:00Z", prerelease: false, security: false }] });
  },
});
process.env.WEBUI_TELEMETRY_URL = `http://127.0.0.1:${good.port}`;
const seeded = await getNotices({ force: true });
check("partial: seed read is fresh with both feeds", seeded.unavailable === false && seeded.announcements.length === 1 && seeded.versions.length === 1);

// The versions feed now 500s; announcements still serve (with a DIFFERENT id,
// so "live feed" is distinguishable from "served the cache").
const partial = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/announcements") {
      return Response.json({ announcements: [
        { id: 88, title: "Newer notice", body: "Live.", level: "info", product: "opencode-webui", published_at: "2026-10-18T00:00:00Z", expires_at: null },
      ] });
    }
    return new Response("down", { status: 500 });
  },
});
process.env.WEBUI_TELEMETRY_URL = `http://127.0.0.1:${partial.port}`;
const merged = await getNotices({ force: true });
check("partial failure keeps the last-good versions (not blanked)", merged.versions.length === 1 && merged.versions[0]?.name === "3.4.0");
check("partial failure serves the live feed, not the cache", merged.announcements.length === 1 && merged.announcements[0]?.id === 88);
check("partial failure is flagged unavailable", merged.unavailable === true);

// A partial read must NOT overwrite the last-good cache: the next call inside
// the TTL still serves the fresh copy, not a stale-flagged one.
const afterPartial = await getNotices();
check("a partial read does not overwrite the last-good cache", afterPartial.unavailable === false && afterPartial.versions.length === 1);

// 2c. Total failure WITH a live cache yields the last good copy, flagged stale.
process.env.WEBUI_TELEMETRY_URL = "http://127.0.0.1:1";
const stale = await getNotices({ force: true });
check(
  "total failure with a live cache keeps the last good copy, flagged unavailable",
  stale.unavailable === true && stale.versions.length === 1 && stale.announcements.length === 1,
);
partial.stop(true);
good.stop(true);

// ---------------------------------------------------------------------------
// 3. Sanitizers reject junk and trim over-long bodies
// ---------------------------------------------------------------------------
const dirty = sanitizeAnnouncements({ announcements: [
  { id: 1, title: "ok", body: "x".repeat(MAX_BODY_CHARS + 500), level: "EVIL", product: "p", published_at: 1 },
  { title: "no id" },
  "junk",
  null,
]});
check("announcement sanitizer drops rows without an id", dirty.length === 1);
check("announcement sanitizer clamps the level", dirty[0]?.level === "info");
check("announcement sanitizer trims the body", (dirty[0]?.body.length ?? 0) === MAX_BODY_CHARS);
check("version sanitizer requires a name", sanitizeVersions({ versions: [{ tag: "v1" }, { name: "1.0.0" }] }).length === 1);
check("non-array feeds yield []", sanitizeAnnouncements(null).length === 0 && sanitizeVersions({}).length === 0);

// ---------------------------------------------------------------------------
// 4. Pure selection rules
// ---------------------------------------------------------------------------
const anns = notices.announcements;
check("pickAnnouncement prefers security", pickAnnouncement(anns, [])?.id === 4);
check("pickAnnouncement respects dismissal", pickAnnouncement(anns, ["4"])?.id === 9);
check("pickAnnouncement returns null when all dismissed", pickAnnouncement(anns, ["4", "9"]) === null);
check("matchingRelease tolerates a v prefix", matchingRelease(notices.versions, "v3.4.1")?.name === "3.4.1");
check("matchingRelease is null for an unknown version", matchingRelease(notices.versions, "9.9.9") === null);
check("summarizeRelease truncates", summarizeRelease("a".repeat(2000), 10) === "aaaaaaaaaa…");

// dismissal persistence
store.clear();
dismissAnnouncement(4);
check("dismissal persists and de-duplicates", JSON.stringify(getDismissedAnnouncementIds()) === JSON.stringify(["4"]));
dismissAnnouncement(4);
check("re-dismissing is idempotent", JSON.stringify(getDismissedAnnouncementIds()) === JSON.stringify(["4"]));
check("dismissal key is the documented one", store.has(DISMISSED_ANNOUNCEMENTS_KEY));

// ---------------------------------------------------------------------------
// 5. RENDER: the notice surface actually renders the announcement markup
// ---------------------------------------------------------------------------
const securityHtml = renderToStaticMarkup(
  createElement(UpdateNotice, { state: "current", announcement: anns[1] }),
);
check("security announcement renders data-oc-announcement", securityHtml.includes("data-oc-announcement"));
check("security level is exposed for styling", securityHtml.includes('data-oc-announcement-level="security"'));
check("security announcement shows title + body", securityHtml.includes("Rotate token") && securityHtml.includes("CVE fixed."));
check("security announcement is labelled loudly", securityHtml.includes("Security notice"));
check("security announcement is dismissible", securityHtml.includes("data-oc-announcement-dismiss"));

const infoHtml = renderToStaticMarkup(
  createElement(UpdateNotice, { state: "current", announcement: { id: 2, title: "Hello", body: "", level: "info", product: "p" } }),
);
check("info announcement renders with the default label", infoHtml.includes("Announcement") && infoHtml.includes("Hello"));

const updateHtml = renderToStaticMarkup(
  createElement(UpdateNotice, { state: "available", version: "3.4.1", currentVersion: "3.4.0", release: notices.versions[0] }),
);
check("an offered update renders with its release note", updateHtml.includes("data-oc-update-whats-new") && updateHtml.includes("3.4.1"));
check("a security release is marked loudly", updateHtml.includes('data-oc-update-security="true"') && updateHtml.includes("Security update"));

// fail-soft render: nothing to show => empty markup, no throw
const emptyHtml = renderToStaticMarkup(
  createElement(UpdateNotice, { state: "current", announcement: null }),
);
check("no announcement + current state renders nothing", emptyHtml === "");

// ---------------------------------------------------------------------------
// 6. Settings › About list order + the card's Details affordance
// ---------------------------------------------------------------------------
const unsorted: WebuiAnnouncement[] = [
  { id: 1, title: "old", body: "", level: "info", product: "p", published_at: "2026-01-01T00:00:00Z" },
  { id: 2, title: "new", body: "", level: "warning", product: "p", published_at: "2026-10-01T00:00:00Z" },
  { id: 3, title: "undated", body: "", level: "info", product: "p", published_at: null },
];
check("sortNewestFirst orders newest first", sortNewestFirst(unsorted).map((a) => a.id).join(",") === "2,1,3");
check(
  "sortNewestFirst keeps feed order for undated ties",
  sortNewestFirst([{ id: 7, published_at: null }, { id: 8, published_at: null }]).map((x) => x.id).join(",") === "7,8",
);
check("sortNewestFirst never mutates its input", unsorted[0]?.id === 1 && unsorted[1]?.id === 2);
check(
  "sortNewestFirst orders release notes newest first",
  sortNewestFirst([
    { name: "1.0.0", published_at: "2026-01-01T00:00:00Z" },
    { name: "2.0.0", published_at: "2026-10-01T00:00:00Z" },
  ])
    .map((r) => r.name)
    .join(",") === "2.0.0,1.0.0",
);

// The Details affordance is opt-in (a prop) — it is the pointer to Settings ›
// About and must NOT change the card's own lifecycle or content.
const detailsHtml = renderToStaticMarkup(
  createElement(UpdateNotice, { state: "available", version: "3.4.1", onDetails: () => {} }),
);
check("the update card exposes a Details affordance", detailsHtml.includes("data-oc-update-details"));
check("the Details affordance is labelled", detailsHtml.includes(">Details<"));
const plainHtml = renderToStaticMarkup(
  createElement(UpdateNotice, { state: "available", version: "3.4.1" }),
);
check("no Details affordance when the host does not wire one", !plainHtml.includes("data-oc-update-details"));
const annDetailsHtml = renderToStaticMarkup(
  createElement(UpdateNotice, { state: "current", announcement: anns[1], onDetails: () => {} }),
);
check(
  "the announcement card exposes a Details affordance",
  annDetailsHtml.includes("data-oc-announcement-details") && annDetailsHtml.includes("data-oc-announcement"),
);

// ---------------------------------------------------------------------------
if (saved.WEBUI_TELEMETRY_URL === undefined) delete process.env.WEBUI_TELEMETRY_URL;
else process.env.WEBUI_TELEMETRY_URL = saved.WEBUI_TELEMETRY_URL;

console.log(`\ncheck:notices — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
