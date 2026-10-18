# Release helper — opencode-webui

**Read this before every release; update it after every release.** Always
cross-check against the actual repo state (`git log`, `package.json`, the
`AGENTS.md` Release pointer) before executing anything here — evidence from
the repo beats this file.

> Lives at `.opencode/release-helper.md` on purpose: the **super-vibe** ship
> skill looks for exactly this path. The dated **Entries** below refer to the
> docs layout at the time of that release.

- **Last released version:** `3.4.2` (tag `v3.4.2`) — tag pushed, GitHub Release
  Latest, and **published to npm from the owner's shell (`HOME=/home/zowail`,
  where `npm whoami` → `zowail`)** with `WEBUI_TELEMETRY_KEY` sourced from
  `~/.config/opencode/webui/telemetry.env` (see Credentials + the 3.4.2 entry).
- **Version source of truth:** `package.json` `"version"` (the server reads it
  at boot for `/api/webui/status|config`; `scripts/gen-skill.ts` pins the skill
  to it). Bump that ONE line.
- **Registry:** npm, package `opencode-webui`, publisher `zowail`.
- **Repo:** `origin` = `https://github.com/AbdelftahZowail/opencode-webui.git`
  (branch `master`).
- **Committed:** yes — this file lives in the repo (convention established at
  3.2.0). Keep it updated in the release commit.

## Credentials

- `npm whoami` must print `zowail` (npm auth via the user's `.npmrc`).
  **On this box the answer depends on which shell you are in** — there are two
  `HOME`s: the owner's (`/home/zowail`) holds the token (`npm whoami` → `zowail`,
  exit 0; 3.4.0 *and* 3.4.1 were published from there), while the cloud agent
  shell (`HOME=/home/ubuntu`) has no `_authToken`/`NPM_TOKEN` anywhere and
  answers `ENEEDAUTH`. So an `ENEEDAUTH` does **not** mean the token is missing
  from the machine: check `echo $HOME` / `ls -l ~/.npmrc` first, and if the
  token only exists in the owner's home, either publish from there or ask the
  owner to plant the token in the agent `~/.npmrc`. An *isolated* `HOME`/`XDG_*`
  (what the check scripts and test harnesses pin) produces the same
  `ENEEDAUTH` — re-run `npm whoami` in a plain shell before concluding anything.
  Everything up to and including the tag push completes in either shell.
- git push over HTTPS must have push access to `origin` (`master` + tags).
- **`WEBUI_TELEMETRY_KEY` (3.4.2+)**: the hub's `HUB_WRITE_KEY`, required by
  `prepublishOnly`. Kept on the owner's box as
  `~/.config/opencode/webui/telemetry.env` (0600, `WEBUI_TELEMETRY_KEY=…`):
  `set -a; . ~/.config/opencode/webui/telemetry.env; set +a` before `npm publish`.
  If it is missing, pull it from the hub container on the VPS (recipe under
  **Hub operations**) — never print it, never commit it. A *generated* key is
  useless: the hub rejects anything that is not its own `HUB_WRITE_KEY` (401).
- **Counter-observation (3.4.1, agent shell):** `npm whoami` → `ENEEDAUTH` with
  `HOME=/home/ubuntu` (not isolated), `npm config get userconfig` →
  `/home/ubuntu/.npmrc`, and that file holds only `min-release-age` /
  `allow-scripts` — no `_authToken`, no `NPM_TOKEN`, nothing under
  `~/.config/npm`. `/home/zowail` does **not exist on this box**, so the owner's
  token is not reachable from the agent shell at all — publishing must happen in
  the owner's shell, or with a token planted in the agent `~/.npmrc`.
- No other secrets. `WEBUI_PASSWORD`/engine credentials are runtime-only.

## Release steps (exact)

From the repo root, on `master`, with a clean release scope:

1. **Recon.** `git status`, `git log --oneline -10`, `git tag --sort=-v:refname | head`.
   Decide the scope; stage **explicit paths**. Never blanket `git add -A`.
2. **Gates** (all green, no exceptions):
   - `bun run typecheck`
   - `bun run build`
   - the four batteries **sequentially and alone** (see gotchas):
     `bun run scripts/uitest/ext-battery-browser.ts`,
     `…-dom.ts`, `…-proxy.ts`, `…-acceptance.ts` → expect **77/0**
   - `bun run check:setup` → expect **61/0**
   - `bun run check:notices` → expect **47/0** and `bun run check:telemetry`
     → expect **63/0** (both offline; the `:live` variants read the real hub)
   - `npm pack --dry-run` for the packed file list
3. **Commits** split by workstream (see the `git log` style: conventional
   subject + a body that enumerates the change and the gates). Keep
   extension-contract work and unrelated work in separate commits.
4. **Bump** `package.json` `version` (semver; a no-contract-change feature set
   is a minor bump).
5. **Regen the skills:** `bun run scripts/gen-skill.ts`; verify **both**
   `skills/webui/SKILL.md` and `skills/testkit/SKILL.md` show the new version and
   pin `v{version}`.
6. **Release commit** containing `package.json` + `skills/webui/SKILL.md` +
   `skills/testkit/SKILL.md` (+ this file). Tag it: `git tag v{version}`.
7. **Push:** `git push origin master --tags` (never force). Pushing the tag is
   what makes the skill's pinned raw links resolve — **never publish without
   the tag**.
8. **Publish:** `npm publish`. `prepublishOnly` runs
   `bun run typecheck && bun run gen:skill && bun run build && bun run gen:telemetry-key`,
   so `dist/` is rebuilt fresh AND the telemetry ingest key is baked into
   `dist/telemetry-key.json` before packing. **`WEBUI_TELEMETRY_KEY` must be set
   in the publishing shell** (the hub's `HUB_WRITE_KEY`, from
   `/home/ubuntu/quickly-hub/.env`) or the publish ABORTS. That guard is
   deliberate — 3.4.0/3.4.1 shipped with no key and collected nothing while every
   gate stayed green. Put it in the **shell or a CI secret**, not in a `.env`:
   Bun auto-loads `.env` and this repo does not gitignore it. Note
   `npm publish --ignore-scripts` skips `prepublishOnly` and would ship inert
   silently — never publish with it here.
9. **Verify it landed:** `npm view opencode-webui version` shows the new version;
   the GitHub tag page resolves; a couple of the skill's `v{version}` raw links
   return 200.
10. **Write the "What's New" (release notes) — REQUIRED, not optional.** Pushing
    the tag makes CI create the GitHub Release with `--generate-notes` (a raw
    commit list). The hub version feed is sourced from those **GitHub Release
    bodies**, and that feed is exactly what users see in the in-app **Update
    notice** and **Settings › About → "What's new"**. Replace the auto notes with
    a short, user-facing "What's New":
    `gh release edit v{version} --notes-file /tmp/whats-new.md`
    (or edit the release on github.com). 3–6 plain-language bullets: what's new,
    what changed, anything breaking. See `## "What's New" is a release artifact`.
    The release job `needs: binaries`, so the GitHub Release does not exist until
    the 5-leg binary matrix finishes — wait for CI (or retry the `gh release
    edit`) before step 11.
11. **Update this file** (last version + a dated entry).

## "What's New" is a release artifact (the hub feed)

The in-app **Update notice** and **Settings › About → "What's new"** do **not**
read a changelog file in this repo — they render the hub version feed
(`GET /v1/versions?product=opencode-webui`). The hub sources that feed from
**GitHub Releases** (`HUB_GITHUB_REPOS` in the hub's `.env`; the map must contain
`opencode-webui=AbdelftahZowail/opencode-webui` or it falls back to the default
repo). Release bodies with `<!-- security -->` are flagged security-critical and
surfaced more loudly by both clients.

Consequence: **the release's notes ARE the product announcement.** A tag whose
notes are only the auto-generated "Full Changelog" line ships an empty What's
New. So every release: write a short user-facing "What's New" into the GitHub
Release body (step 10). There is no `CHANGELOG.md` and no repo file to maintain —
the GitHub Release is the source of truth.

## Gotchas (learned the hard way)

- **Batteries must run sequentially and with NO other agent/subagent active.**
  All agents share one engine; a concurrent subagent floods `/api/event` and
  evicts the proxy battery's tap ring (it keeps the last 50 session ids), so
  `ext-battery-proxy` test 8 (`onEvent tap headless`) flakes. Run alone and it
  is stable.
- **The npm tarball does NOT contain `src/**`** (`package.json` `files` =
  `["dist","server","skills","scripts/testkit","webui-extensions/README.md"]`). The frontend ships
  compiled in `dist/`; the server ships as TypeScript source because the `bin`
  runs `server/index.ts` under Bun. So `server/shelf.ts`,
  `server/shelfEnginePlugin.ts`, etc. ARE packed, but `src/components/…` are not.
  **Verify the production-shaped path, not just dev:** `npm pack`, extract,
  symlink `node_modules`, run the packed `server/index.ts` against the packed
  `dist/`, and confirm `/login`, `/api/webui/config`, `/api/shelf/list`, and the
  `/api/event` stream (which must carry `server.connected` AND
  `webui.extensions` frames).
- **Never restart/respawn the engine or the prod webui.** For a prod-shaped
  smoke test use a throwaway port + isolated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`
  and, to guarantee no spawn, set `WEBUI_ENGINE_URL`/`WEBUI_ENGINE_PASSWORD`
  from the live `service.json`. `WEBUI_NO_SETUP=1` prevents touching the global
  command/plugins. This proxy has a loopback-guarded registration fallback and a
  bounded engine resolver, but don't rely on it — pin the engine explicitly.
- **Mixed-workstream files** (`src/store.ts`, `server/index.ts`,
  `server/setup.ts`) may carry several workstreams. Hunk-split only when it is
  clean and safe; otherwise one detailed commit that enumerates everything is
  acceptable.
- **Design docs CAN be committed when they carry no private data.** A roadmap /
  proposal doc (e.g. `docs/plans/extensions.md`) is fine to push once the
  owner confirms it has nothing private or machine-specific — it is the
  "what's next" map. This reversed the earlier "leave roadmap-2 untracked" rule
  at 3.3.0; decide per-doc, do not blanket-untrack.
- **Personal extensions never ship from this repo.** `webui-extensions/` is the
  SHIPPED stratum; the user's own extensions live in
  `~/.config/opencode/webui-extensions/` (a separate git checkout) and are
  loaded as the higher-precedence USER stratum. At 3.3.0 two extensions were
  removed from the repo for this reason (`autopilot/`, `source-control/`) and
   the unpushed commits that added them were dropped. Before releasing, confirm
   nothing personal is under `webui-extensions/` and that no core doc/code
   references a removed personal extension by name.
- **`npm publish` returns HTTP 202 "being processed"** in this environment, and
  the packument can lag a couple of minutes. Do not conclude failure from a
  quick re-read.
- **The publisher's own `~/.npmrc` sets `min-release-age=5`**, so `npm view` /
  `npm install` on this machine HIDE versions younger than 5 days — a
  just-published version looks like a 404/old `latest` even though it landed.
  Verify against the registry API directly (cache-bust the packument):
  `curl -s "https://registry.npmjs.org/opencode-webui?t=<nano>"` → check
  `dist-tags.latest` and `time[<version>]`; the version doc
  `https://registry.npmjs.org/opencode-webui/<version>` should be 200; the
  `dist.tarball` should download. The npm poller's "latest" is NOT evidence
  here.
- **The committed OpenAPI snapshot was re-synced on 2026-10-07** to the live
  engine (2.0.22; 116 paths / 255 schemas); `bun run scripts/diff-openapi.ts
  --check` exits 0. A re-sync is still its own workstream — **do not run
  `fetch-openapi.ts` as part of an unrelated fix**: it desyncs `src/api/types.ts`
  and every row of `docs/reference/coverage.md`. Prefer the narrow fix plus a
  dated scope note in `docs/reference/coverage.md` (what 3.2.1+ `caaf5ad` did).
  `diff-openapi.ts` can also die with `TypeError: body is not an Object` inside a
  stale `Service.ensure()`; the API-sync scripts now resolve the engine through
  `server/engineDiscovery.ts`, so retry resolves it.
- **Verify a gate actually fails before trusting it.** `check:unseen`'s
  stamp-throttle regression was written with a 1.2s gap and passed with the
  bug present — `SETTLE_SLOP_MS` (2s) absorbed it, making the guard vacuous.
  The window that actually distinguishes them is >slop and <old-throttle. Any
  assertion with a millisecond window needs the same both-ways proof:
  reintroduce the bug, watch the check go red, restore it.
- Scratch lives in `/tmp/opencode/`. Do not touch
  `~/.config/opencode/webui-extensions/` or the skills/commands dirs.
- **Telemetry is inert without a BAKED key — and that failure is invisible.**
  `3.4.0`/`3.4.1` collected **zero** installs: `DEFAULT_TELEMETRY_KEY = ""`, the
  hub's `/v1/telemetry` gates on `X-Quickly-Key` (= its `HUB_WRITE_KEY`), and
  `telemetryActive()` needs `url && key` — so no install ever sent, while every
  gate (including `check:telemetry`, which passes a key explicitly) stayed green
  and `Settings › About › Usage data` read `configured:false`. **Fixed in 3.4.2:**
  `prepublishOnly` runs `bun run gen:telemetry-key`, which writes
  `dist/telemetry-key.json` (packed + gitignored) and **aborts the publish when
  `WEBUI_TELEMETRY_KEY` is unset**. `server/telemetry.ts` resolves
  `env → dist/telemetry-key.json → ""` (fail-open on a missing/corrupt file).
  Compiled binaries are inert by channel (`updateChannel() → "binary"`), so they
  never send and need no key — this is npm-only. **When reading the hub, a 0 is
  still not a download count** (everyone may have opted out); npm's per-version
  stats are the download number, and they lag ~1–2 days.
- **Hub hygiene:** the production hub's `instance` table is the product's real
  telemetry. Two mock instances created by live telemetry testing during the
  3.4.0 build (`product=quickly` + `app_version=3.4.0` — impossible for Quickly,
  which is 2.x; one had the all-`b` id `bbbb…`) were identified and **deleted on
  2026-10-18** (rows dumped to the scratch dir first; `instance_event` /
  `instance_daily` / `instance_error` checked and had no children for them).
  Only the genuine `quickly 2.4.0` docker install remains. The **test** hub
  (`quickly-hub-test`, `127.0.0.1:8599`) still holds its deliberately seeded
  fixture instances — that is a test DB, leave it unless asked.
- **Live telemetry checks WRITE to the production hub.** Every accepted
  `check:telemetry:live` run inserts a **new** `instance` row (the script uses a
  throwaway `XDG_STATE_HOME`, so the id is random), and a probe run from the repo
  **without** a temp state dir reuses the REAL install id and overwrites that
  install's row facts. The 3.4.2 verification left **5 phantom rows** —
  `f23c88f0d07646dfbea31a998aa122bc`, `47a88ea7995b447080db00ec5db1f24d`,
  `1fbd8cde53ef4ac7a534974994b94b2f`, `69f9360c6edb415086cd3621df48515a`,
  `a73d2cf1004d43a19caddbfbe80bac44` — all `app_version=3.4.2` with the script's
  hardcoded fingerprint (`sessions_count=3`, `extensions_count=2`), left for the
  owner to delete. Use a throwaway id and clean up after yourself.
- **`opencode-webui update` can fail on a cold bun cache.** The 3.4.1 → 3.4.2
  update first died with `update failed — could not resolve the latest version`:
  the inner `Bun.spawnSync([bun, "x", "opencode-webui@latest", "internal:setup"],
  { timeout: 60_000 })` was killed while resolving ~1194 fresh packages. Warm it
  (`bun x opencode-webui@latest status`, or any `bun x` run) and re-run — the
  retry finished in **2.3 s**. Fallback if it still trips: run
  `bun x opencode-webui@latest internal:setup` yourself, then
  `opencode-webui restart`.
- **npm download stats lag ~1–2 days.** `api.npmjs.org` buckets trailed real
  publishes by ≥1 day at 3.4.1 (newest bucket 2026-10-16 for tags pushed
  2026-10-18), so a fresh tag cannot be counted there yet; re-check ~48h later.

## Hub operations (the telemetry / notices / versions backend)

The hub is **not** in this repo and **not** on this box: it runs on the VPS
(`ssh mini-vps`, also the tailnet host `vps` / `100.89.10.21`), source
`/home/ubuntu/quickly-hub`, compose project `quickly-hub`.

| Piece | Where |
| --- | --- |
| App container | `quickly-hub-hub-1` → `127.0.0.1:8099` (FastAPI: `/v1/telemetry`, `/v1/versions`, `/v1/announcements`, `/health`, `/admin`) |
| DB | `quickly-hub-db-1` (postgres; db `quickly_hub`, user `postgres`; tables `instance`, `instance_event`, `instance_daily`, `instance_error`, `announcement`) |
| Test hub | `hub-test` → `127.0.0.1:8599` (separate DB — fixtures, leave it alone) |
| Edge | `/etc/caddy/Caddyfile`, site block `# BEGIN QUICKLY-HUB` |
| Product summary | `curl "http://localhost:8099/admin/api/summary?product=opencode-webui"` (from the VPS; publicly behind basic auth at `/admin`) |

**Getting the ingest key (`HUB_WRITE_KEY`) without printing it:**

```sh
ssh mini-vps "docker inspect quickly-hub-hub-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^HUB_WRITE_KEY='" > /tmp/k && rm -f /tmp/k   # rename the var, keep mode 0600, never echo
```
Locally it lives as `WEBUI_TELEMETRY_KEY=…` in
`~/.config/opencode/webui/telemetry.env` (0600): `set -a; . <file>; set +a`
before `npm publish`. The hub validates it (`X-Quickly-Key`) and answers
`401 {"detail":"invalid write key"}` for anything else — so a *generated* key is
useless; it must be the deployed one.

**`/v1/announcements` was NOT routed publicly — FIXED 2026-10-18.** The Caddy
site block only had `handle` blocks for `/admin`, `/v1/versions*`, `/health*` and
`/v1/telemetry*`, then fell through to `respond "Not found" 404`, while the hub
app itself served the route (`localhost:8099` → 200). The in-app **notice card**
therefore had no announcement source (the **versions** feed — Update notice /
Settings › About → "What's new" — was never affected). Fix applied: a backup
(`/etc/caddy/Caddyfile.bak-20261018-201118`), this block inserted before the
fallback, `caddy validate` → *Valid configuration*, then `systemctl reload caddy`
(graceful):

```
	handle /v1/announcements* {
		reverse_proxy 127.0.0.1:8099
	}
```

Verified: from the VPS `https://telemetry.shortformfunnels.com/v1/announcements?product=opencode-webui`
→ **200** `{"product":"opencode-webui","announcements":[]}`; `/health` and
`/v1/versions` still 200. Note the **edge can lag a reload by seconds**: an
immediate request from the laptop still answered the old `404 "Not found"`,
while a retry a few seconds later returned `200` (`via: 1.1 Caddy`,
`cf-cache-status: DYNAMIC`). The proxy side then flipped too: `/api/webui/notices`
went `unavailable:true` (partial: announcements failing) → **`unavailable:false`**
with a `fetchedAt` stamp, i.e. a complete, cached copy. Zero announcements exist
yet, so the card stays quiet until one is published.

**Hub facts worth knowing:** the hub carries the per-product enums for us already
(`WEBUI_ACTIVATION_EVENTS = {"setup_completed"}`, `WEBUI_FEATURE_NAMES =
{"extensions","dom_extensions","proxy_extensions"}`), and `app_version` is only
**format**-checked (`VERSION_RE`) — not validated against released versions. One
`POST /v1/telemetry` was rejected `422` during the 3.4.2 verification and never
reproduced (4 consecutive 202s after, hub container never restarted) — if you see
it again, capture the response body: the repo's `check:telemetry:live` swallows it.

## Entries

### 3.4.2 — 2026-10-18
- **Type:** patch (fixes; no extension-contract change).
- **Shipped:** **telemetry actually reports now.** 3.4.0/3.4.1 shipped the feature
  with `DEFAULT_TELEMETRY_KEY = ""` and no key in the artifact, so
  `telemetryActive()` was false everywhere and the hub collected nothing — while
  every gate (including `check:telemetry`, which passes a key explicitly) stayed
  green. `server/telemetry.ts` now resolves the key
  `WEBUI_TELEMETRY_KEY` → `dist/telemetry-key.json` (baked at publish) →
  `DEFAULT_TELEMETRY_KEY` (still empty, so a checkout never sends; a missing or
  corrupt baked file is fail-open). New `scripts/gen-telemetry-key.ts` writes that
  file from the env with mode 0600 and **refuses to produce an artifact without a
  key**; `prepublishOnly` runs it, so `npm publish` fails loudly instead of
  shipping inert. The key never enters git (`dist/` is packed and gitignored) —
  the same shape Quickly uses (`QUICKLY_TELEMETRY_KEY` at build time). Compiled
  binaries stay inert by channel (`updateChannel() → "binary"`): npm-only. The
  static handler now 404s `GET /telemetry-key.json` (it is server-side data, not
  a browser asset), the generator's `--out` is fenced to tests and cannot write
  the key to a tracked path, and an existing file is chmodded to 0600.
  `check:telemetry` grew 11 checks — deterministic in BOTH states (a published
  checkout's key file is stashed and restored, so the suite no longer goes red
  after a publish): no key in git; the env override wins; the baked key is used
  and makes the release ACTIVE; a corrupt file is fail-open; and the generator's
  refusal (+ why), its 0600 output, and that it never echoes the key → **63/0**.
- **Docs:** `docs/reference/telemetry.md` ("Opt-out, on by default in a release",
  the bake step, the resolution order, the key's public/global nature),
  `docs/operations.md`, `AGENTS.md` (packaging/CI), `README.md` (its "no
  telemetry" line was no longer true — and the README ships inside the tarball
  that now sends), and this file's publish step + the inert-telemetry gotcha.
- **Publish (done 2026-10-18):** `WEBUI_TELEMETRY_KEY` was missing from the box,
  so it was pulled from the hub's own container on the VPS and parked in a local
  0600 file (`~/.config/opencode/webui/telemetry.env`) — never through the
  transcript; see **Hub operations** below for the recipe. `prepublishOnly` then
  baked it (`[gen-telemetry-key] baked the ingest key (64 chars) ->
  dist/telemetry-key.json`) and `npm publish` exited 0.
  Evidence: registry lagged ~2 min (`latest` `3.4.1` → `3.4.2`); the packument
  matched the local pack — `fileCount` **297** (was 296, +`dist/telemetry-key.json`),
  **5,159,199 B**, shasum **`7f21ac486477d280c6c1e94763db874a317fc084`**. The
  tarball downloaded at that size/sha1 and contains `dist/telemetry-key.json`
  (64-char key, mode **0600 in the tarball**), `dist/` + `server/` byte-identical
  to the repo; no `src/`. **`04`** aside: an *installed* copy lands 0644 — npm/bun
  extraction does not preserve the mode — inside the 0700 state dir, which is
  fine because the key is public-by-design inside the tarball anyway.
- **Instance updated + telemetry PROVEN end-to-end:** `opencode-webui update`
  → `v3.4.1 → v3.4.2`; `GET /api/webui/config` = 3.4.2; `/api/webui/telemetry`
  flipped `configured:false, active:false` → **`configured:true, active:true`**;
  `GET /telemetry-key.json` → **404** (was 200 on 3.4.1). A restart then produced
  the +45 s first heartbeat: local `seq` 1 → 2 and the hub's `instance` row updated
  with the install's **real** facts (`sessions_count 50`, `extensions_count 8`,
  `payloads 2`). The repo's own `check:telemetry:live` accepted the released
  payload 4 runs in a row (2xx) after one **unexplained, unreproducible 422** —
  worth re-watching, but the payload the release actually sends is accepted.
- **Verified:** typecheck 0, build 0, `check:telemetry` **63/0** (with AND without
  a published key file present), extension battery **35/10/17/15 = 77/0**,
  `check:setup` **61/0**, `check:notices` **47/0**, a real `npm pack` extracted to
  scratch resolves `""` with no baked key and the key with one (the packed-install
  layout, not just the repo), the static handler now 404s
  `/telemetry-key.json`, and a 6-assertion probe showed the resolution flipping
  `telemetryActive()` **false → true** (checkout ⇒ inert, baked ⇒ active, env
  override wins, corrupt file ⇒ fail-open).

### 3.4.1 — 2026-10-18
- **Type:** patch (a fix + one small shipped hint + a doc sweep; no
  extension-contract change — no target / collection / service id, `data-oc-*`
  anchor, registry kind, hook, or bridge key moved).
- **Shipped:** (1) **issue #1** — the Worktrees panel 400'd on every call. The
  engine keys `GET/POST/DELETE /api/worktree` off the owning **project**
  (`GET /api/worktree?location[directory]=…` → `400 Missing key at
  ["projectID"]`, `?projectID=<id>` → 200; `Worktree.CreateInput` /
  `RemoveInput` require `projectID` in the body). `cbe89af` fixed only
  `worktreeRefresh`. Now `worktreeList` / `Create` / `Remove` resolve the project
  from `/api/location` (`projectIDFor`) and send it, with **no** location-scoped
  retry — a retry could only re-send a mutation and mask the real 400/422 with
  the fallback's own failure (the mirror of `forkSession`'s "only fall back when
  both shapes give the same message" rule). `coverage.md`'s worktree row **and**
  its "Removed (2)" bullet now record the project-scoped truth (the "location-
  scoped / removed upstream" claim WAS the bug). (2) The **`~~~` inline-preview
  hint ships with the webui**: core renders the tilde fences (`fence.ts` +
  `PreviewBlock.tsx`), but nothing told the model the syntax existed.
  `server/previewEnginePlugin.ts` is a hint-only managed engine plugin
  (`opencode-webui-preview/`: one `{ type: "text" }` part via
  `ctx.session.hook("context")`, no tools); `setup.ts` installs/uninstalls it
  beside the lifecycle + shelf plugins (`WEBUI_NO_PLUGIN=1` skips all three) and
  `pluginPresent` now checks all three dirs. Docs swept: the v1 engine seam
  (`experimental.chat.system.transform`) is gone from
  `engine-payload-convention.md` / `extension-system-spec.md` /
  `webui-extensions/README.md` in favour of v2 `{ id, setup }` +
  `ctx.session.hook("context")`, and every "two managed plugins" became three.
- **Adversarial verification (2 fresh-context verifiers + 1 re-verifier):** the
  first pass found **2 BLOCKING** — (i) the worktree fallback masked real errors
  and re-sent mutations (fixed: no retry; proven by a stub-fetch probe that a
  genuine 400 propagates with exactly ONE request, and that an unresolvable
  location sends no worktree request at all); (ii) `coverage.md`'s "Removed (2)"
  bullet still called the replacement route location-scoped (fixed). Non-blocking
  fixes taken: stale "location-scoped" comments (`client.ts` header +
  `projectIDFor` docstring, `WorkspacePicker`, `WorktreePanel`, `store.ts`),
  `pluginPresent` widened, `shelfEnginePlugin`'s "skips both" → all three, the
  last "two plugins" doc spots (README, `docs/README.md`, the generated skill's
  prose), and a doc overclaim that the preview hint teaches the `live-*` aliases.
  Residual (non-blocking, shipped): `opencode-webui status` still *names* only
  the lifecycle dir in its `plugin:` line (the boolean is now correct, the path
  is not); a user who keeps the personal `rich-render` extension folder gets a
  near-duplicate hint (the engine still loads its payload).
- **Gate evidence:** typecheck ✅, build ✅, extension battery
  **35/10/17/15 = 77/0**, `check:setup` **61/0** (was 51/0: +10 for the new
  plugin), `check:notices` **47/0**, `check:telemetry` **52/0**,
  `npm pack --dry-run` **296 files** (was 295; +`server/previewEnginePlugin.ts`,
  still **no `src/`**), plus a 12-assertion stubbed-fetch probe over the four
  worktree methods and an 11-assertion probe of the plugin payload. Live
  read-only engine probes: list `?projectID=` 200 / location 400;
  create/remove/refresh accept the `projectID` payload (a bogus id answers
  `ProjectNotFoundError`, never `Missing key`; nothing created or removed).
- **Publish:** `git push origin master --tags` — first rejected (the laptop's
  `55c8e53` had landed), so the three local commits were **rebased** onto it and
  the single conflict in *this* file resolved to keep both the laptop's 3.4.0 npm
  evidence and the new 3.4.1 entry (no force anywhere). Then `55c8e53..9ec0fa7`,
  tag `v3.4.1` = `9ec0fa7`; the GitHub tag API is 200; all six `v3.4.1` pinned
  raw links are 200; CI `Release` succeeded (**two** runs fired — the tag was
  pushed, deleted and re-pushed during the rebase; both went green and the
  second's assets are the attached ones) → the GitHub Release is **Latest** with
  the 5 binaries + `SHA256SUMS.txt`, its auto body replaced by a user-facing
  **`npm publish` DID run — from the owner's shell (`HOME=/home/zowail`), not the
  agent one.** `npm whoami` → `zowail` there, exit 0; the agent shell
  (`HOME=/home/ubuntu`) still answers `ENEEDAUTH`, which is why this entry first
  recorded 3.4.1 as unpublished (see Credentials). Evidence (2026-10-18):
  publish exited 0 with `prepublishOnly` clean (typecheck + `gen:skill` + build);
  the registry lagged **~3 min** this time (doc 404 → 200, `latest` `3.4.0` →
  `3.4.1`); then the packument matched the local pack exactly — `fileCount`
  **296**, **5,158,409 B**, shasum
  **`20f09a71cef733c791dc0676a7e85d59289e0f8a`**, integrity
  `sha512-pVj12ToFIU0tXD4JD1GKUOm+cZhBATuxg0jw448Mw90YSA2Y57qVmfuQdmBsPjIQuIXAZbJ55D+eLzHyJQgclQ==`,
  `time["3.4.1"] = 2026-10-18T02:18:26.717Z`. The tarball downloaded at that
  size/sha1, and `dist/` (261 files) + `server/`, `skills/`, `scripts/testkit`,
  `webui-extensions/README.md` are **byte-identical** to the repo at the tag; no
  `src/`. Re-verified independently on the publishing host: typecheck ✅,
  build ✅, `check:setup` **61/0**, `check:notices` **47/0**, `npm pack
  --dry-run` **296** (post-build); the GitHub Release `v3.4.1` is **Latest**
  (6 assets), the tag API is 200, and all six `v3.4.1` pinned raw links are 200;
  a prod-shaped smoke from the *extracted tarball* (fresh `bun install
  --production`, isolated `HOME`/`XDG_*`, `WEBUI_NO_SETUP=1`, dead
  `WEBUI_ENGINE_URL`) bound `:4124`, `/login` 200, `/api/webui/status` 401,
  skills auto-synced, engine-unreachable tolerated. The hub feed now answers
  `repo: AbdelftahZowail/opencode-webui` and lists **3.4.1** first — the mapping
  gap is closed (the 3.4.0 entry's defensive `repo` guard is still unshipped).

### 3.4.0 — 2026-10-18
- **Type:** minor (features + fixes). One documented-subset change for wrappers:
  the target `composer.contextReadout` was removed (the composer readout became
  the `composer.usageBar` session usage bar) — now recorded in the authoring
  guide's new "Contract changes (migration notes)" table. No other target /
  collection / service id, `data-oc-*` anchor, registry kind, or hook was
  renamed or removed.
- **Shipped:** the R0–R14 TUI-parity program (tabs + pins, timeline, attention,
  stats, diff completeness, composer, transcript fidelity, tool cards, overlays,
  settings/themes, forms, extension-API code-block renderers) plus the markdown
  pipeline (R1/R2: shiki, mermaid, katex) — landed on master in `477f247` and
  earlier; then the R3–R14 follow-ups (composer usage bar, per-turn `tok/s` and
  its panel, tool-card R10 completeness, live shell output + an error-latch
  reset), **product notices** (hub announcements + release notes, per-feed
  last-good, row/date caps, `GET /api/webui/notices`), **anonymous-usage
  telemetry** (release-gated, opt-out, `WEBUI_TELEMETRY=false` hard kill, fixed
  allowlist, `GET/PUT /api/webui/telemetry`), the **testkit** harness (real
  Chromium + real tmux TUI; `bun run testkit:example`), and generated skills for
  both ids (`gen:skill` → `skills/{webui,testkit}/SKILL.md`, installed on boot by
  `skillSync`). Settings gained the About tab (seven tabs now).
- **Adversarial verification (5 fresh-context verifiers + 1 re-verifier):**
  secrets/privacy/scope/packaging → **1 BLOCKING**: `scripts/testkit/harness.ts`
  hard-coded `/home/ubuntu/.hermes/cache/scratch/opencode`, a machine path
  shipping in the npm tarball; fixed to `join(homedir(), …)` (behaviour
  identical). Docs coherence → **1 BLOCKING**: AGENTS.md claimed the tarball
  holds four entries "only" while `files` now also carries `scripts/testkit`;
  fixed. Client parity → **1 BLOCKING**: removing `composer.contextReadout` had
  no migration note (a silent contract break by the repo's own rule); fixed with
  the migration-notes table. All three re-verified RESOLVED with a second
  fresh-context pass. Non-blocking fixes taken: notices per-feed last-good on a
  partial failure (a single feed blip used to blank the other for the whole 6h
  TTL *and* report `unavailable:false`), `MAX_ROWS`/`asDate` caps,
  `Number.isFinite(row.id)`, the shell-output error latch cleared on a fresh
  acquire (a poll that 404s before the session location resolves used to lose
  live output for the rest of the call), and doc-accuracy corrections
  (AGENTS / README / release-helper / coverage / telemetry / agent-testing).
  Residual (non-blocking, shipped): a partial read stamps `fetchedAt` with
  `now` though one feed is stale (no consumer reads it); `skillSync` overwrites
  a *user* skill that reuses the `webui`/`testkit` id (bounded to those two
  ids); `ComposerUsageBar` recomputes its aggregates per render (the old inline
  readout was memoized); `--surface-brand-weak/-strong` are undefined tokens
  (pre-existing).
- **Gate evidence:** typecheck ✅, build ✅, extension battery
  **35/10/17/15 = 77/0**, `check:setup` **51/0**, `check:notices` **46/0**
  (both-ways proven: **45/1** with the partial-cache fix reverted),
  `check:telemetry` **52/0**, `npm pack --dry-run` **295 files / 5.2 MB**
  (dist + server + skills + `scripts/testkit` + `webui-extensions/README.md`;
  **no `src/`**).
- **Publish:** `git push origin master --tags` → `477f247..94730a3`, tag
  `v3.4.0` = `94730a3`; the GitHub tag API is 200; all five `v3.4.0` pinned raw
  links are 200; CI `Release` run `39086046174` succeeded → the GitHub Release
  was created with `--generate-notes` and its auto body was then replaced with a
  user-facing "What's New" (`gh release edit v3.4.0 --notes-file …`).
  `npm publish` **was run from this host** (2026-10-18): `npm whoami` → `zowail`,
  exit 0, and `prepublishOnly` re-ran typecheck + `gen:skill` + build clean. The
  earlier `ENEEDAUTH` reading in this entry came from an isolated `HOME`/`XDG`
  shell, not from a missing token — see Credentials.
  Evidence: publish exited 0 ("being processed"); the registry lagged **~8 min**
  (version doc 404 → 200 at 04:39Z, `dist-tags.latest` `3.3.0` → `3.4.0`); then
  the packument matched the local pack exactly — `fileCount` **295**,
  size **5,156,802 B**, shasum **`2720725dc215073a19a4a9b5b8dd417970b02d62`**,
  integrity `sha512-uV5gkMie0MkAqzcFuHbUqRreu2jMbu/VI/KFCz2IQwnMz5BvUflZ47krIlyjHcH46DqR9pmTeTrZ4MutyyfmLA==`.
  The tarball downloaded at that size/sha1 (after one `{"error":"Not found"}`
  CDN blip — retry, do not call it missing) and `dist/` (261 files) + `server/`,
  `skills/`, `scripts/testkit` are **byte-identical** to the repo at the tag;
  no `src/`. GitHub Release `v3.4.0` is **Latest** with all five binaries +
  `SHA256SUMS.txt` and a user-facing body (no "Full Changelog").
  Prod-shaped smoke from the *extracted tarball* (fresh `bun install
  --production`, then an isolated `HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`,
  `WEBUI_NO_SETUP=1`, a deliberately dead `WEBUI_ENGINE_URL`): bound `:4123`,
  `/login` 200, `/api/webui/status` 401 (auth gate live), skills auto-synced
  into the isolated config, engine-unreachable logged and tolerated.
- **Gotchas hit at 3.4.0 (worth remembering):**
  - **A stale `node_modules` breaks the build.** The pre-3.4.0 tree had none of
    the R1/R2 deps, so `bun run build` died with `[vite]: Rolldown failed to
    resolve import "shiki/core"`. Run `bun install --frozen-lockfile` after any
    pull that changes `package.json` *before* trusting a gate result.
  - **`npm pack --dry-run` reflects an *unbuilt* `dist/`.** `npm pack` runs
    `prepack`/`prepare`, not `prepublishOnly`, so without a prior build it
    reported **51 files / 2.1 MB**; after `bun run build` (or via `npm publish`,
    whose `prepublishOnly` builds) it is the real **295 files / 5.2 MB**. Never
    publish off a dry-run count taken before a build.
  - **A fresh checkout can be behind even when the handoff says otherwise.**
    This one sat at `1e3bb4b` (`v3.3.0-2`) until `git pull --ff-only`; always
    confirm with `git rev-parse HEAD origin/master` + `git describe --tags`.
- **✅ RESOLVED 2026-10-18 (hub-side, not this repo):** `GET
  https://telemetry.shortformfunnels.com/v1/versions?product=opencode-webui`
  answered **`repo: AbdelftahZowail/Quickly`** (and `/v1/announcements` → "Not
  found") because the hub's `HUB_GITHUB_REPOS` had no `opencode-webui` mapping
  and fell back to its default repo, so the in-app Update notice / Settings ›
  About showed **Quickly's** release notes to opencode-webui users. The proxy
  side was always correct (it sends `product=opencode-webui`, caches, fails
  open). **Fix:** the hub lives at `/home/ubuntu/quickly-hub` (not a git
  checkout; container `quickly-hub-hub-1`, `127.0.0.1:8099`, Caddy
  `telemetry.shortformfunnels.com`). Its code ALREADY supported the plural map
  (`app/config.py` `repo_for_product()` + `app/routers/announcements.py`), but
  the deployed container was from **2026-10-12** (no announcements router, no
  product validation) and `.env` (Sep 24) had only the singular
  `HUB_GITHUB_REPO`. So: appended
  `HUB_GITHUB_REPOS=quickly=AbdelftahZowail/Quickly,opencode-webui=AbdelftahZowail/opencode-webui`
  (backup `.env.bak-1792289276`), `docker compose build hub` (no downtime),
  smoke-tested the new image on :8598 against the compose network, then
  `docker compose up -d hub`. Verified on the **public** host:
  `?product=opencode-webui` → `repo: AbdelftahZowail/opencode-webui` with
  `3.4.1/3.4.0/3.3.0`, `/v1/announcements` → 200 `[]`, and
  `?product=quickly` still → `AbdelftahZowail/Quickly`. Rollback image:
  `quickly-hub-hub` `dfb0f07cfa68`. **Gotcha:** `.env` is un-versioned, so a
  hub redeploy must set `HUB_GITHUB_REPOS` again (`.env.example:18` and the
  hub `README.md` document the format). Consider (optional, would be a 3.4.2 —
  the tag is already cut) having `server/notices.ts` discard a feed whose
  top-level `repo` is not this repo, so a future misconfigured hub yields
  *nothing* rather than another product's notes.
  Re-confirmed live on 2026-10-18: the response is
  `{"source":"github","repo":"AbdelftahZowail/Quickly","versions":[… 2.5.0 …]}`.
  The top-level `repo` is **already in the documented shape** but ignored by
  `sanitizeVersions`, so the guard needs **no hub change and no new field** — the
  expected value can come from `package.json` `repository`. Measured caveats: the
  hub is slow/flaky from this host (one read ~1 s, later reads hung past 45–60 s)
  and `/v1/announcements?product=opencode-webui` never answered, so a copy can be
  `unavailable: true` *while still rendering a foreign product's notes*. Because
  Quickly's rows top out at 2.5.0 (< 3.4.0), the "update available" card likely
  will not fire — the visible damage is **Settings › About → "What's new"** (and
  the announcements surface once it answers).

### 3.3.0 — 2026-10-07
- **Type:** minor (features + fixes; no extension-contract break — no
  target/collection/service id, registry kind, hook, or bridge change). One
  documented-subset change for wrappers: `sidebar.sessionRow` no longer receives
  `active` / `subagentsActive` (the row derives its run badge from
  `sessionOrSubagentsLive`). Not a versioned-contract break: the spec (§ rule 4)
  version-contracts IDs, not props.
- **Shipped:** queue/engine-drift fixes (permission reply body `reply` →
  `decision` with legacy fallback; form listing `/api/form/request` → `/api/form`;
  form state off the retired `/state` route onto `GET .../form/{id}`;
  `cancelForm` DELETE; status-based fallbacks via `statusOf`; evidence-based
  permission removal with a newborn-grace age gate; boolean `replyPermission` +
  failed-reply UI). Folder-wide hot-reload fingerprint (`folderSourceMtime`).
  Sidebar run-badge unification + infinite-scroll session loading. Message-rail
  rework + convergent search scroll + `composer.above` moved above the composer
  swap. `docs/extension-roadmap-2.md` committed.
- **Repo cleanup (this release):** the two personal extensions were removed from
  the repo — `webui-extensions/autopilot/` and `webui-extensions/source-control/`
  (byte-identical copies live in `~/.config/opencode/webui-extensions/`, the USER
  stratum) — and the two unpushed commits that added source-control were dropped
  (`git reset --mixed origin/master`). `webui-extensions/` now ships only the core
  `report` extension. Dangling `scm.ts` / `autopilot.ts` references in core
  comments/docs were genericized.
- **Adversarial verification (4 fresh-context verifiers + 2 re-verifiers):**
  secrets/privacy/scope clean; API/store and UI passes found two BLOCKING
  defects — (1) `formState`'s status sniff missed JSON 404s (engine `message`
  does not contain the status), so the store's form reap silently never fired;
  fixed by attaching `.status` in `request()` + `statusOf`; (2) permission
  removal had no age gate and could drop (and tombstone) a freshly asked
  permission that lagged both listings; fixed with `permissionFirstSeen` +
  `NEWBORN_GRACE_MS`. Both re-verified RESOLVED with live-engine probes
  (JSON-404 shape, `{decision}` vs `{reply}` → 400). Also fixed: the frozen
  `useStore(() => new Set)` chip label; the sidebar observer not re-attaching
  after collapse/expand; and three coverage.md/roadmap-2 doc inaccuracies.
  Residual (non-blocking, shipped as-is): `CollapsedSessionLink` still keys its
  dot off `active` (expanded row is migrated; cosmetic asymmetry); a permission
  whose per-session verification keeps FAILING is kept pending indefinitely
  (fail-safe by design); the coverage.md table still lists the snapshot path
  `/api/form/request` (covered by the route-map preamble).
- **Gate evidence:** typecheck ✅, build ✅ (clean rebuild; `dist/assets` carries
  only the `report` chunk — the stale private-extension chunks/glob strings were
  a BLOCKING finding for the npm tarball and are gone), batteries
  **34/10/17/15 = 76/0**, `check:setup` **51/0**, `npm pack` 36 files (no `src/`).
  Prod-shaped tarball smoke on a throwaway port + isolated XDG (packed server +
  packed dist, engine pinned): `/` 200, `/api/webui/config` 200,
  `/api/shelf/list` 200, `/api/event` carries `server.connected` +
  `webui.extensions`.
- **Publish:** `npm publish` exited 0 with HTTP-202 "being processed". Verified
  against the cache-busted packument: `dist-tags.latest = 3.3.0`,
  `time["3.3.0"] = 2026-10-07T12:42:01.550Z`; version doc 200; tarball
  `https://registry.npmjs.org/opencode-webui/-/opencode-webui-3.3.0.tgz`
  downloaded, **2,033,973 B**, sha1 `a172cbef79bbb8f8231e1a48ad6c94a6418d59d7`
  (matches the packument), 36 entries, no `autopilot`/`source-control`/`src/`.
  Tag `v3.3.0` = `ba63644`; GitHub tag HTML/API 200; the skill's `v3.3.0` raw
  links return 200 (`webui-extensions/README.md`, `src/api/client.ts`,
  `src/components/Sidebar.tsx`, `docs/extension-roadmap-2.md`,
  `skills/webui/SKILL.md`). NOTE: the tarball CDN lagged the metadata by ~1 min
  (404 then 200) — the packument updating first is expected; retry the tarball,
  do not call it missing.

### 3.2.1 — 2026-10-05
- **Type:** patch (fixes; no extension-contract break).
- **Shipped:** slash-command engine compat — `api.runCommand` sends **both**
  `name` and `command` (+ the required `text`); the 2.0.22 engine requires
  `name` and rejects `{command}` with `Missing key at ["name"]`, the documented
  2.0.3 snapshot requires `command`, and the engine ignores the extra key.
  Sidebar sticky-rows fix — live/open/finished-but-unopened sessions render at
  their own sorted spot instead of widening the newest-N prefix, plus an
  `unseen` "new" badge on finished-while-unopened sticky rows. Matching docs.
- **Adversarial verification (3 fresh-context verifiers):** client.ts vs both
  engine shapes — live runtime proof on 2.0.22 that `{command}` alone → 400
  `Missing key ["name"]`, while `{name,command,text}` and a deliberately
  unknown extra key → 404 CommandNotFound (body accepted; excess keys ignored
  at runtime despite OpenAPI `additionalProperties:false`, Effect-Schema
  default). Sidebar index math — 300k-case brute force: no negative
  `moreCount`, no duplicate/dropped rows, collapsed/Show-more/selected
  preserved. Secrets/quality/docs sweep — clean; one stale coverage bullet
  fixed. Residual (non-blocking, shipped as-is): 2.0.3 could not be executed
  here, so "old engine ignores excess keys" is inferred (same Effect-Schema
  stack), not directly proven; and a "Show more" press can reveal 0 rows when
  a sticky cluster starts exactly at the prefix boundary (UX-only; every row
  stays reachable).
- **Gate evidence:** typecheck ✅, build ✅, batteries 34/10/17/15 = 76/0,
  `check:setup` 51/0, `npm pack --dry-run` 36 files (dist, server incl.
  shelf*.ts, skills, webui-extensions/README.md; no src/).
- **Publish:** `npm publish` exited 0 with HTTP-202 "being processed" (expected
  here); the cache-busted packument showed `dist-tags.latest = 3.2.1` ~2.5 min
  later (`time["3.2.1"] = 2026-10-05T09:06:46.261Z`). Version doc 200; tarball
  `https://registry.npmjs.org/opencode-webui/-/opencode-webui-3.2.1.tgz`
  downloaded, 2,026,932 B, sha1 `cfb69b2852e8fed3d938b9488348c172d6ec4d74`
  (matches the packument). Tag `v3.2.1` = `c85744f`; GitHub tag HTML + API 200;
  the skill's `v3.2.1` raw links return 200
  (`webui-extensions/README.md`, `src/api/client.ts`, `src/components/Sidebar.tsx`,
  `docs/extension-system-spec.md`, `skills/webui/SKILL.md`).

### 3.2.0 — 2026-10-05
- **Type:** minor (features; no extension-contract break).
- **Shipped:** core markdown pipeline (tables, tilde-fence live previews, shelf
  chips); new-session model memory (pin → last-used → engine default → first
  enabled); core file shelf (`/api/shelf/*`) + the `shelf_*` engine-tools plugin;
  streaming resilience (one SSE per tab — the manifest push rides `/api/event` —
  plus the loopback-guarded engine registration fallback and the `sessionWait`
  staleness gate); `internal:setup` entry-URL stabilization.
- **Gate evidence:** typecheck ✅, build ✅, batteries 34/10/17/15 = 76/0,
  `check:setup` 51/0, prod-shaped tarball smoke ✅, pack contents verified.
- **Notes:** batteries had been run with a concurrent verifier and flaked
  (proxy test 8) — re-run alone is green; recorded above. `npm publish`
  returned HTTP 202 ("being processed"); the registry showed
  `dist-tags.latest = 3.2.0` a few minutes later, version doc 200, tarball
  2,026,841 B / shasum `1217067154eecae025faaf293e7e6e77df018504` containing
  `server/shelf.ts` + `server/shelfEnginePlugin.ts` + `dist/` + the skill.
  Tag `v3.2.0` = `f3326de`; pinned raw links all 200.
