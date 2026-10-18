#!/usr/bin/env bun
/**
 * Live notices read — proves the proxy's hub read against a REAL hub.
 *
 *   WEBUI_TELEMETRY_URL=http://127.0.0.1:8599 bun run check:notices:live
 *
 * Reads the same two public feeds the proxy reads on demand and prints what
 * came back. Exits non-zero when the hub was unreachable (`unavailable`), so it
 * doubles as a smoke test for a hub deploy. Never prints a key (none is used —
 * these are public reads).
 */
import { __resetNoticesCache, getNotices } from "../../server/notices";

const url = (process.env.WEBUI_TELEMETRY_URL ?? "").trim();
if (!url) {
  console.error("notices-live: WEBUI_TELEMETRY_URL is required");
  process.exit(2);
}

__resetNoticesCache();
const notices = await getNotices({ force: true });
console.log(
  `notices-live: hub ${new URL(url).host} · unavailable=${notices.unavailable} · ` +
    `announcements=${notices.announcements.length} · versions=${notices.versions.length}`,
);
for (const a of notices.announcements) console.log(`  [${a.level}] ${a.title}`);
for (const v of notices.versions.slice(0, 3)) console.log(`  v${v.name}${v.security ? " (security)" : ""}`);
console.log(`notices-live: ${notices.unavailable ? "UNAVAILABLE" : "OK"}`);
process.exit(notices.unavailable ? 1 : 0);
