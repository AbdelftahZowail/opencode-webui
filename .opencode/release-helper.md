# Release helper — opencode-webui

**Read this before every release; update it after every release.** Always
cross-check against the actual repo state (`git log`, `package.json`, the
`AGENTS.md` "Release checklist") before executing anything here — evidence from
the repo beats this file.

- **Last released version:** `3.3.0` (tag `v3.3.0`)
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
- git push over HTTPS must have push access to `origin` (`master` + tags).
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
     `…-dom.ts`, `…-proxy.ts`, `…-acceptance.ts` → expect **76/0**
   - `bun run check:setup` → expect **51/0**
   - `npm pack --dry-run` for the packed file list
3. **Commits** split by workstream (see the `git log` style: conventional
   subject + a body that enumerates the change and the gates). Keep
   extension-contract work and unrelated work in separate commits.
4. **Bump** `package.json` `version` (semver; a no-contract-change feature set
   is a minor bump).
5. **Regen the skill:** `bun run scripts/gen-skill.ts`; verify
   `skills/webui/SKILL.md` shows the new version and pins `v{version}`.
6. **Release commit** containing `package.json` + `skills/webui/SKILL.md` (+ this
   file). Tag it: `git tag v{version}`.
7. **Push:** `git push origin master --tags` (never force). Pushing the tag is
   what makes the skill's pinned raw links resolve — **never publish without
   the tag**.
8. **Publish:** `npm publish`. `prepublishOnly` runs
   `bun run typecheck && bun run gen:skill && bun run build`, so `dist/` is
   rebuilt fresh before packing.
9. **Verify it landed:** `npm view opencode-webui version` shows the new version;
   the GitHub tag page resolves; a couple of the skill's `v{version}` raw links
   return 200.
10. **Update this file** (last version + a dated entry).

## Gotchas (learned the hard way)

- **Batteries must run sequentially and with NO other agent/subagent active.**
  All agents share one engine; a concurrent subagent floods `/api/event` and
  evicts the proxy battery's tap ring (it keeps the last 50 session ids), so
  `ext-battery-proxy` test 8 (`onEvent tap headless`) flakes. Run alone and it
  is stable.
- **The npm tarball does NOT contain `src/**`** (`package.json` `files` =
  `["dist","server","skills","webui-extensions/README.md"]`). The frontend ships
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
  proposal doc (e.g. `docs/extension-roadmap-2.md`) is fine to push once the
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
- **The committed OpenAPI snapshot is STALE — do not run `fetch-openapi.ts` as
  part of an unrelated fix.** As of 2026-10-07 the live engine serves a block
  of routes under `/api/experimental/` and has renamed others;
  `bun run scripts/diff-openapi.ts` reports 28 paths the snapshot documents
  that the engine no longer serves, and 21 live paths it does not document.
  It bit hard on session export: `api.exportSession` called
  `/api/session/{id}/export`, which 404s, while
  `/api/experimental/session/{id}/export` answers 200 — so "Export" and
  `/copy` silently did nothing. `diff-openapi.ts` also dies with
  `TypeError: body is not an Object` inside `Service.ensure()` when a
  previously-spawned engine has died; retrying does not always clear it.
  Regenerating the snapshot is its own workstream, not a drive-by: it would
  desync `src/api/types.ts` and every row of `docs/coverage.md`. Prefer the
  narrow fix plus a dated scope note in `docs/coverage.md` (what 3.2.1+
  `caaf5ad` did).
- **Verify a gate actually fails before trusting it.** `check:unseen`'s
  stamp-throttle regression was written with a 1.2s gap and passed with the
  bug present — `SETTLE_SLOP_MS` (2s) absorbed it, making the guard vacuous.
  The window that actually distinguishes them is >slop and <old-throttle. Any
  assertion with a millisecond window needs the same both-ways proof:
  reintroduce the bug, watch the check go red, restore it.
- Scratch lives in `/tmp/opencode/`. Do not touch
  `~/.config/opencode/webui-extensions/` or the skills/commands dirs.

## Entries

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
