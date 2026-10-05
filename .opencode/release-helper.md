# Release helper — opencode-webui

**Read this before every release; update it after every release.** Always
cross-check against the actual repo state (`git log`, `package.json`, the
`AGENTS.md` "Release checklist") before executing anything here — evidence from
the repo beats this file.

- **Last released version:** `3.2.0` (tag `v3.2.0`)
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
- **Do not commit in-progress design docs** (e.g. `docs/extension-roadmap-2.md`
  at 3.2.0) — leave them untracked.
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
- Scratch lives in `/tmp/opencode/`. Do not touch
  `~/.config/opencode/webui-extensions/` or the skills/commands dirs.

## Entries

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
