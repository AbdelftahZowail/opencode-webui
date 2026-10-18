# Product notices (announcements + What's New)

The webui surfaces two product-scoped hub feeds on **two surfaces**: the
bottom-right **notice card** (the same card as the app-update notice,
`update.notice` — the transient "you must know now" surface) and the permanent
**Settings › About** page (the "find it later" home — see below).

- **Announcements** — short, ad-hoc operator messages ("Gmail API incident
  resolved", "rotate your token"). Published from the hub's private admin
  surface.
- **Release notes** — the hub's version feed, used as the primary "new version"
  content: an offered update shows its release note, and a `security` release is
  marked loudly.

## Data path

```
page  ──/api/webui/notices──▶  proxy (server/notices.ts)  ──▶  hub (public GETs)
```

The browser never calls the hub (CORS; one cached read per proxy). The proxy
read is **fail-open**: an unreachable or erroring hub yields the last good copy,
or `{ announcements: [], versions: [], unavailable: true }` — never an error,
never a blocked boot.

### Hub reads (public, no key)

| Feed | Shape |
| --- | --- |
| `GET {hub}/v1/announcements?product=opencode-webui` | `{ product, announcements: [{ id, title, body, level, product, published_at, expires_at }] }` — already filtered to live, unexpired rows, newest first |
| `GET {hub}/v1/versions?product=opencode-webui` | `{ source, product, repo, versions: [{ name, tag, title, body, published_at, prerelease, security }] }` |

`level` is `info` \| `warning` \| `security`. `security` mirrors the release
feed's `<!-- security -->` marker and is rendered more loudly.

## Privacy

Both reads are **public**: no key is sent, and the only thing that leaves the
machine is the constant `product=opencode-webui` in the URL. Nothing about the
install is transmitted. This is not telemetry and is deliberately **not** gated
on the telemetry opt-out — a security announcement must reach a user who has
telemetry off.

## Rendering + dismissal

The card shows the highest-severity un-dismissed announcement (`security` >
`warning` > `info`, then newest). Dismissing one reveals the next and is
persisted in `localStorage` (private-mode safe):

- `webui.notices.dismissedAnnouncements` — a capped list of announcement ids
- `webui.update.dismissedVersion` — the app-update skip (existing)

An install/restart the user must act on outranks a passive announcement, so the
update notice takes the card back while it is in flight. The pure selection +
persistence rules live in `src/lib/notices.ts` (testable without a DOM); the
rendering is the announcement branch of
`src/components/UpdateNotice.tsx`. Markup anchors:
`data-oc-announcement`, `data-oc-announcement-level`,
`data-oc-announcement-dismiss`, `data-oc-announcement-details`; the update
variant keeps `data-oc-update-*`, adds `data-oc-update-security` /
`data-oc-update-whats-new`, and carries `data-oc-update-details`.

The card is the **transient** surface ("you must know now"): it appears on a
normal app open while an un-dismissed live item exists — never tied to a login
or a process restart, never "once ever". Dismissal persists so it stops nagging
for that id; a new announcement id shows again. The card is responsive: below
`sm` it spans the viewport with side insets and sits above the composer /
activity strip, its body scrollable under a capped height; from `sm` up it is
the bottom-right card.

## Settings › About (the permanent home)

The card is transient; **Settings › About** is the "find it later" home for the
same feeds. It is purely additive — the card is unchanged. One `About` tab (the
`settings.about` target), top-to-bottom:

1. **Version + channel** — the running build (`GET /api/webui/config`:
   `{ version, build: { tree, rev, dirty } }`) and the install channel from
   `GET /api/webui/update/check` (`dev` / `binary` / `published`).
2. **Updates** — the live status and the Check / Update / Restart actions,
   driven by the **same** R11 state machine the card uses (the store's
   `updateNotice` + `updateCheck` slices — one machine, no duplicate), plus an
   expandable **What's New** = the whole version feed, newest first
   (`settings.about.release` rows, sorted by `sortNewestFirst`).
3. **Announcements** — the FULL live list (level badge, title, body, date),
   newest first, with an empty state (`settings.about.announcement` rows).
   Deliberately **independent of card dismissal**: dismissing the card never
   removes the item from this list.
4. **Usage data** — the anonymous-usage opt-out (the `settings.telemetry`
   target, moved out of its own tab and rendered here at the bottom).

Anchors: `data-oc-about`, `data-oc-about-version`, `data-oc-about-updates`,
`data-oc-about-whats-new`, `data-oc-about-announcements`, `data-oc-about-usage`,
`data-oc-about-release` (+ `-name`), `data-oc-about-announcement` (+ `-level`).
The card's **Details** affordance (`data-oc-update-details` /
`data-oc-announcement-details`) opens this page (`openSettings("about")`).

## Route + config

- `GET /api/webui/notices` → `{ announcements, versions, unavailable, fetchedAt }`,
  behind the same session auth as every other `/api/webui/*` route.
- Hub base: reuses `WEBUI_TELEMETRY_URL` (default the baked public hub). No key
  is required for notices.
- Cache: 6h in the proxy (`NOTICES_CACHE_MS`).

## Checks

- `bun run check:notices` — offline: the proxy read (stub hub), fail-soft on an
  unreachable hub, the sanitizers, the pure selection/dismissal rules, and the
  **rendered** markup of the announcement + release-note cards (static React
  render — no browser).
- `bun run check:notices:live` — reads the two feeds from a real hub
  (`WEBUI_TELEMETRY_URL=…`); exits non-zero if the hub is unreachable. Doubles as
  a post-deploy smoke test.
