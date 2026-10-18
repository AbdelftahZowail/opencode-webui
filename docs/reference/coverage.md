# API coverage — have / don't have / why

Source of truth for the HTTP contract: `reference/openapi.json`
(snapshot of the running service's `/openapi.json`, **116 paths / 255 schemas —
synced 2026-10-07 against engine 2.0.22**). The live engine reports its version
at `GET /api/info` (`{ version: "2.0.22", … }`). Refresh:
`bun run scripts/fetch-openapi.ts`. Diff against live:
`bun run scripts/diff-openapi.ts` (also `--json`, `--check` for CI).
The scripts resolve the engine through `server/engineDiscovery.ts` (spawn-free
discovery + the registration fallback), so they work against a drifted engine.
Raw diff: `git diff reference/openapi.json`.

The re-sync procedure is `docs/runbooks/engine-update.md`.

`src/api/client.ts` holds one typed function per resource group (plus its own
wire-shape interfaces); `src/api/types.ts` holds the session/message/permission
schema types. `server/index.ts` proxies any `/api/*` + websockets generically,
so new routes work without a proxy change. Keep the store as sole state
(`src/store.ts`).

> Roadmap principle: "everything the engine can do must eventually be reachable from the UI"
> — but only user-facing resources get UI; internals stay client-only. This doc is that map.
>
> **Scope note (2026-09-15):** the engine also serves a *legacy unprefixed*
> surface (`/session/**`, `/lsp`, `/formatter`, `/session/{id}/todo`,
> `/session/{id}/share`, `/path`, `/experimental/workspace/*`,
> `/experimental/console/*`, `/global/upgrade`) that this OpenAPI snapshot does
> **not** document.
>
> **It is still out of scope.** `@opencode/client` on branch `v2` declares 115
> endpoints and all of them are `/api/*` — the v2 TUI never touches the legacy
> surface, which exists for the **v1** TUI. `server/index.ts` forwarding only
> `/api/*` is therefore correct, no proxy bridge is wanted, and the legacy-only
> features the v1 TUI had (todos, LSP/formatter status, session share, console
> orgs) are **not** v2 capabilities. See `docs/plans/parity.md`.
>
> **Synced as of 2026-10-07 (engine 2.0.22) — Step 0 of the parity plan.**
> The prior snapshot (2026-09-15, 123 paths / 241 schemas, engine 2.0.3) was
> regenerated: 28 documented routes had been removed upstream, 21 live routes
> were undocumented, and 88 were modified (schema inlining + a block moved under
> `/api/experimental/*`). The snapshot now matches live and
> `bun run scripts/diff-openapi.ts --check` exits 0. Every table below is written
> from the **current** snapshot.
>
> **The drift had silent shape changes, not just moved paths.** A moved path
> 404s (visible); a moved *body key* or *query key* is rejected or ignored
> (silent). Three bit shipped features and are now patched:
>
> - **Permission reply body** (`reply` → `decision`, `additionalProperties:false`)
>   — sent the wrong name 100% of the time, so a permission could never be
>   answered, the request stayed pending forever, and the "waiting in another
>   session" chip became un-clickable. `replyPermission` sends the current field
>   and retries the legacy one on a 400/422.
> - **Interrupt query key** (`continue` → `resume`) — unknown query keys are
>   silently ignored, so `?continue=true` did a **plain** interrupt on 2.0.22
>   (verified live: `?continue=true` → `interrupted:false` semantics; both keys
>   → resume). `api.interrupt` now sends **both** keys.
> - **Slash-command identifier** (`command` → `name`) — `api.runCommand` sends
>   both `name` and `command` (plus the required `text`); the engine's runtime
>   ignores the key it does not know (verified live: `{name,command,text}` →
>   `204`).
>
> Also fixed in the same pass: `activateSkill` (`skill`→`id`, moved under
> `/api/experimental/`), the permission-*rules* PUT (gone; now `PATCH
> /api/session/{id}`), inbox `steer`/`queue` (consolidated to
> `PATCH …/inbox/{id} {delivery}`), `renameSession` (`POST …/rename` → `PATCH
> /api/session/{id}`), `revertClear` (`POST …/revert/clear` → `DELETE
> /api/session/{id}/revert`), `projectCurrent` (`/api/project/current` gone;
> derive from `/api/location.project`), `serverInfo` (`/api/server` →
> `/api/info`), `generate` and the MCP write/action routes (now
> `/api/experimental/*`), and the `/api/vcs/branches` → `/api/vcs/branch`
> rename. Two further *body* changes were caught by independent verification
> and fixed: `forkSession` (`{boundary}` → `{before: messageID | null}` — the
> engine ignored the unknown old key, so it silently forked the wrong boundary)
> and `worktreeRefresh` (now requires `{ projectID }`; it previously sent no
> body and 400'd). Removed upstream with no replacement: `/api/health`, `/api/server`,
> `POST /api/service/stop`, `/api/plugin/await-activation`, and
> `PATCH /api/shell/{id}/timeout` (see "Removed upstream" below).
>
> **This doc is a route map, not a backlog.** Its "genuine gap" and "client-only"
> rows record *why* a route has no UI — they are an inventory, not a to-do list.
> The remaining work for full v2-TUI port parity (feature-level, not route-level)
> lives in **`docs/plans/parity.md`**, which is the document to hand a fresh
> agent.

## Have — wired in the webapp

| API group | OpenAPI paths | Client | UI |
| --- | --- | --- | --- |
| health/server | `GET /api/info` | `api.health` (proxy-local), `api.serverInfo` | Connection footer reads the **proxy-owned** `/api/webui/status` via `api.health`. `api.serverInfo` reads `GET /api/info` (`ServerInfo`: version/pid/urls/paths) and is client-only — the Settings → Server tab was deliberately de-surfaced as informational |
| session lifecycle | `GET/POST /api/session`, `GET/PATCH/DELETE /api/session/{id}`, `GET /api/session/active`, `POST fork`, `POST move`, `POST compact`, `GET /api/experimental/session/{id}/export`, `POST /api/experimental/session/{id}/wait` | `listSessions`, `createSession`, `getSession`, `deleteSession`, `activeSessions`, `forkSession`, `renameSession` (PATCH session `{title}`), `exportSession`, `compactSession`, `sessionWait` (via store) | Sidebar, session page, session actions (rename/fork/export/compact/move via inbox). `renameSession` is now `PATCH /api/session/{id}` (`POST …/rename` was removed); legacy route kept as a 404/405 fallback. `exportSession`/`sessionWait` moved under `/api/experimental/` (legacy path on 404). Session creation accepts `permissions`. **`forkSession` body renamed** `{boundary}` → `{before: messageID | null}` (the old key was silently ignored → wrong fork boundary); legacy body kept as a 400/422 fallback |
| prompt/command/skill/synthetic/shell | `POST /api/session/{id}/prompt`, `POST command` (`{name, text, …}`), `POST synthetic`, `POST shell`, `POST generate` (session-scoped), `GET context`, `GET message`, `GET message/{id}`, `POST /api/experimental/session/{id}/skill` | `prompt`, `promptWithFiles`, `runCommand`, `activateSkill`, `sessionShell`, `messages` | Composer, slash menu, `@` file refs, `!` bash, skill picker, shell panel. `runCommand` sends `name` **and** `command` (+ required `text`) so one request works on either engine generation. `activateSkill` moved under `/api/experimental/` with the body field renamed `skill` → `id`. `instructions/entries` moved under `/api/experimental/` and is **unwrapped** (no UI) |
| events (SSE) | `GET /api/event` | `src/api/events.ts` | `store.handleEvent` live streaming (queued→running→ordered parts, poll fallback) |
| permissions/forms/questions | `GET /api/permission/request`, `GET/DELETE /api/permission/saved[/{id}]`, `GET/POST /api/session/{id}/permission*`, `PUT /api/session/{id}/permission/{requestID}/reply` (`{decision, message}`), `GET /api/form`, `GET /api/session/{id}/form`, `GET/DELETE /api/session/{id}/form/{id}`, `POST /api/session/{id}/form/{id}/reply` | `pendingPermissions`, `replyPermission`, `permissionSavedList/Delete`, `pendingForms`, `sessionForms` (per-session backfill), `formState/replyForm/cancelForm`, legacy `question*` | `PendingRequestsPanel` (composer-slot FIFO panel per focused session + corner chip for others), queue in store. Ground truth (2026-08-26, `scripts/uitest/probe-*.ts`, re-verified 2026-10-07): GLOBAL form listing can omit a pending question-form indefinitely under load — mounted sessions are polled per-session and unioned by id; `GET .../form/{id}` carries the form's own `state` (the old `.../state` route is gone), and a 404 is only trusted after a 60s newborn grace; question multiplicity = field type (`multiselect` ⇒ array answers, `string` ⇒ one string); **no native question REST routes on this engine** (events only — the `question*` client methods are legacy and 404 live). Permission listing semantics unverified live (deployment auto-allows) — refresh unions by id. **Removal is now evidence-backed as well as event-driven:** a permission missing from the (location-scoped, laggy) global listing is treated as a *claim* and confirmed against `api.sessionPermissions(sessionID)` before it is dropped. A verification FAILURE keeps the request pending on purpose: a chip that lags is recoverable, a chip that hides a blocked agent is not. **P4 UI:** session menu → "Permission rules…" edits the session ruleset (target `permission.rulesEditor`) and lists the project's saved ("always allow") rules with per-row removal (`permissionSavedList/Delete`) |
| inbox/steering | `GET /api/session/{id}/inbox`, `PATCH/DELETE /api/session/{id}/inbox/{id}`, `POST prompt/synthetic/compact` (`delivery`) | `inboxList/Queue/Steer/Delete`, `inboxPrompt`, `prompt/promptWithFiles` (optional `delivery`) | Explicit STEER vs QUEUE system: busy sends become tracked inbox rows in `QueueStrip` (toggle/send-now/cancel), reconciled by `session.inbox.*` events + poll; queue-drain failsafe on turn end. The old `POST …/inbox/{id}/{steer|queue}` sub-routes were **consolidated** into `PATCH …/inbox/{id}` `{delivery}` (legacy sub-route kept as a 404/405 fallback; verified live: PATCH with a valid `msg_` id reaches the engine's delivery validation, not a 404). **`InboxPanel.tsx` is deleted (R0.5, Wave 0)** — it was defined but never imported/mounted (the live surface is `QueueStrip`) |
| revert | `POST /api/session/{id}/revert/stage`, `DELETE /api/session/{id}/revert`, `POST /api/session/{id}/revert/commit` | `revertStage/Clear/Commit` | `/undo` `/redo`, `applyRevertView` cut of transcript. `revertClear` is now `DELETE /api/session/{id}/revert` (the `…/revert/clear` POST was removed) |
| agent/model/command/skill catalog | `GET /api/agent`, `GET /api/agent/{id}`, `GET /api/model`, `GET /api/model/default`, `GET /api/command`, `GET /api/skill` | `agents`, `models`, `modelDefault`, `commands`, `skills` | Pickers (`Pickers.tsx`), command palette, skill picker, variants; `resolveDefaultModel` runs the model-memory cascade (pin → last used → `modelDefault` → first enabled), so new sessions match the engine/TUI default unless the user has pinned/last-used a model. **Shapes narrowed upstream:** `Command.Info` is now `{name, description?}` (no `template`/`agent`/`model`); `Skill.Info` renamed `location` → `path` and dropped `slash`. `Provider.Info` replaced `disabled` with `activation` (`auto|enabled|disabled`). None of the removed fields were read by the UI |
| provider/integration/credential | `GET /api/provider`, `GET /api/provider/{id}`, `GET /api/integration`, `POST connect/key|oauth|command`, `PATCH/DELETE/POST-activate /api/credential/{id}` | `providerList/Get`, `integration*`, `credentialPatch/Delete/Activate` | `ConnectDialog` (`/connect`, via `/connect` or the palette): integrations catalog, API-key/OAuth/CLI-command connect, stored credentials + **activate / relabel / remove** (P4). **Not a Settings tab** — Settings is Extensions / Plugins / Notifications / Security / Appearance / Shell (+ App on phone) |
| mcp | `GET /api/mcp`, `GET /api/mcp/resource`, `PUT/DELETE /api/experimental/mcp/{server}`, `POST /api/experimental/mcp/{server}/connect|disconnect` | `mcpList/Put/Delete/Connect/Disconnect/Resource` — every wrapper **accepts** `location` (the deployment is single-project, so the indicator deliberately uses the ambient scope) | `McpIndicator` header popover: per-server status, connect/disconnect, **add** (local command / remote url) and **remove** with a two-step confirm (P4). The **write/action routes moved under `/api/experimental/mcp/*`** (only the read routes stayed at `/api/mcp`); each wrapper tries the current namespace and falls back to the legacy path on 404/405. Deliberately ADD-only — there is no single-server read route, so an "edit" would silently clobber the existing config (PUT replaces). `mcpResource` stays client-only |
| filesystem/location/project | `GET /api/fs/read/*`, `GET /api/fs/list`, `GET /api/fs/find`, `GET /api/location`, `GET /api/project`, `PATCH /api/project/{id}` | `fsRead/ReadBytes/List/Find`, `location`, `project*`, `projectUpdate` | FileExplorer, workspace picker, path chips (`projectUpdate` is client-only). **`GET /api/project/current` was removed**; `projectCurrent` now derives the ambient project from `/api/location` (`Location.PublicInfo.project`, verified live), falling back to the legacy route only when the location carries none. `GET /api/project` is a **bare array** |
| vcs | `GET /api/vcs`, `GET /api/vcs/status`, `GET /api/vcs/diff` (+ `base` param), `GET /api/vcs/branch`, `GET /api/vcs/base` | `vcsStatus/Diff/Base/Branches`, `vcsQuery` helper | FileExplorer diff (infers the review base via `vcsBase` and passes its `ref` to `vcsDiff`, so ambiguous Git history doesn't need an explicit base), VCS status badge, the turn-diff viewer's working/committed/branch sources. `vcs/branches` was **renamed to `vcs/branch`** (and `data` is a bare `string[]`); `vcsBranches` now powers the diff viewer's searchable base-branch picker (**R7, done**). **`Vcs.Mode` is `working | branch | committed`; `VcsMode` includes all three and the viewer exposes all four sources (turn / working / committed / branch)** — `docs/plans/parity.md` **R7** |
| pty/shell | `GET/POST /api/pty`, `GET/PUT/DELETE /api/pty/{id}`, `POST connect-token`, `GET connect`, `GET/POST/DELETE /api/shell*` | `pty*`, `shell*` | Shell panel, `TerminalView.tsx` (xterm) via websocket proxy. **`PATCH /api/shell/{id}/timeout` was removed** — a timeout can now only be set at shell creation (`shellCreate`'s `timeout`); the dead `api.shellTimeout` wrapper and the shell panel's set-timeout affordance were **removed** (see Removed upstream) |
| permissions (session rules) | `PATCH /api/session/{id}` (`permissions`), `permissions` on `POST /api/session` | `sessionPermissionRules`, `createSession({permissions})` | **DONE (P4).** Session menu → "Permission rules…" opens an order-aware editor (add/remove/reorder, all three effects, `*` globs). The engine evaluates session rules AFTER the agent's and the LAST match wins, which the editor states and makes legible; save is one `PATCH` (replace semantics, verified → 204) followed by a session re-read. The dedicated `PUT …/permission/rules` route was **removed upstream** (legacy fallback kept) |
| session diff (turn-scoped) | `GET /api/session/{id}/diff?from&to&context` | `sessionDiff` | **DONE (P2).** `DiffViewer` (FileExplorer → "Review", target `diff.viewer`): four sources — last turn / working tree / committed / branch base (R7 added committed + the base picker) — with a changed-file tree, per-file (n/p) and per-hunk (j/k) navigation, split vs unified, and local-only review markers. Distinct from `vcs` diff: this is "what did ONE TURN change". A turn runs idle marker to idle marker, so steered prompts fold into one turn — verified live on this session. `context` is requested (12) because the engine's default is a full-file patch (192 KB for a 4.5k-line file) |
| worktree | `GET /api/worktree?projectID`, `POST/DELETE /api/worktree` (body `{ projectID, … }`), `POST /api/worktree/refresh` (`{ projectID }`) | `worktreeList/Create/Remove/Refresh` | **DONE (P3).** `WorktreePanel` in the WorkspacePicker dropdown: list / create / remove (force, two-step confirm) / refresh; "Use" moves the session into the worktree via the shared `moveSessionToDirectory`. **Project-scoped — corrected in 3.4.1 (issue #1):** the engine keys every worktree route off the owning `projectID` — `GET /api/worktree` takes it as a query param and answers `400 Missing key at ["projectID"]` without it, and `Worktree.CreateInput` / `RemoveInput` require it in the body. The client resolves it from `/api/location` and sends it — `?projectID=` on the list, `projectID` in the create/remove bodies — with no location-scoped retry (it could only re-send a mutation and mask the real error). The earlier "location-scoped; the `{projectID}` routes were **removed upstream**" claim was **wrong** (verified live on 2.0.22: a location-scoped list is a 400), and is what made the panel 400. **Response-shape fix:** `Worktree.List` is a **bare array** and `Worktree.Info` a **bare object** — the P0 wrapper wrongly assumed `{ data }`, which crashed the panel until corrected (the store now also tolerates a non-array). **`POST /api/worktree/refresh` now requires the owning `{ projectID }`** in the body (resolved from `/api/location`); the previous no-body call 400'd `Expected object` |
| config preferences | `PATCH /api/experimental/config` (`{shell}`), `GET /api/config/shell`, `GET /api/config` | `configPreferencesUpdate`, `configShells`, `configGet` | **DONE (R12).** Shell selection now lives in Settings → Shell (`ShellSection`, target `settings.shell`): it lists `configShells()` and reads the current value from `GET /api/config` (the global document), writing via `PATCH /api/experimental/config` `{shell}` (→ 204). It is a **global** preference (no `location`). `GET/PATCH /api/config/preferences` was **removed upstream**; the read half has no replacement so `api.configPreferences` was dropped |
| plugin updates | `GET /api/plugin`, `POST /api/plugin/check`, `POST /api/plugin/update` | `pluginList`, `pluginCheck`, `pluginUpdate`, `pluginAwaitActivation` (no-op) | **DONE (P4).** Settings → Plugins (target `settings.plugins`): every plugin with its source kind, features and state, plus "Check for updates" / per-package check / update (+ update-all for outdated). `updatePlugins` re-reads the catalog after the update (`state` is the authority). `POST /api/plugin/await-activation` was **removed upstream** — `plugin/update` already responds once activation settles — so `pluginAwaitActivation` is now a best-effort no-op that resolves on 404/405. **No enable/disable route exists** upstream: there is nothing to toggle, so no toggle is offered. All four source kinds are handled; the live catalog observed only `builtin` and `local`, so the `package` / `sdk` branches and the "update available" affordance are code-verified but not exercised live |
| websearch | `GET /api/websearch/provider`, `POST /api/websearch` | `websearch*` | **No UI** (client-only) — see the client-only table |
| interrupt/background | `POST /api/session/{id}/interrupt?resume`, `POST /api/session/{id}/background` | `interrupt`, `flushSteersNow` (`resume=true`: interrupt + resume steering, queue stays parked), `sessionBackground` | Esc two-step interrupt, QueueStrip "interrupt & send now", Ctrl+B background subagents. The query key was **renamed `continue` → `resume`**; `api.interrupt` sends **both** so one request works on either engine generation (verified live `?continue=true&resume=true` → 200) |

## Webui extension surface (proxy-owned — not engine OpenAPI, no snapshot drift)

These routes are served by the proxy itself (`server/index.ts`, `server/ext/`,
`server/userExtensions.ts`) for the extension system
(`docs/reference/extension-system-spec.md` §6/`§8`, authoring guide
`webui-extensions/README.md`). They never appear in `docs/reference/openapi.json`
and are intentionally excluded from `scripts/diff-openapi.ts`.

| Endpoint | Served by | Purpose |
| --- | --- | --- |
| `GET /api/webui/extensions` → `{ data: [{ id, source, origin?, name?, description?, url?, domUrl?, disabled?, settings?, requires?, capabilities? }], version }` | `server/index.ts` via `server/userExtensions.ts` discovery | Extension manifest: one loader, three sources (user → project → shipped); folder presence + manifest `disabled` is the only gating; carries declared settings/`requires` through for the Settings card |
| `GET /api/webui/extensions/events` (SSE) | `server/index.ts` manifest listeners | Legacy compat channel for external consumers. Core no longer connects: the manifest push rides the main `/api/event` stream as a `{ type: "webui.extensions", version }` frame (hello on connect + one per change), so a tab holds ONE SSE; the page re-fetches the manifest and same-id-swaps bundles |
| `GET /api/webui/extensions/{id}/bundle.js?v=mtime` | `server/index.ts` via `Bun.build` | Per-extension browser bundle (`index.tsx` entry), ESM cache-busted on the query so hot edits repaint live with no refresh |
| `/api/webui/ext/<id>/…` | `server/ext/registry.ts` `dispatchExtRequest` | Proxy-stratum `server.ts` routes, auto-mounted and namespaced per extension (unknown id/route never falls through to the engine) |
| `GET /api/webui/config` → `{ version, reportRepo }` | `server/index.ts` | Pinned version exposure for the agent skill (`skills/webui/SKILL.md` links pin to the released tag) |
| `GET/PUT /api/webui/settings` | `server/index.ts` via `server/config.ts` | Serve/security settings: file + effective + per-key source, exposure analysis, restart delta; PUT validates and can require `confirm`. Passwords are hashed/redacted. |
| `GET/PUT /api/webui/telemetry` → `{ enabled, envDisabled, active, release, configured, url, version, instanceId }` | `server/index.ts` via `server/telemetry.ts` | Anonymous-usage opt-out: GET reads the effective toggle + whether a hub is configured; PUT persists it. `WEBUI_TELEMETRY=false` is a hard kill that wins over the toggle (`envDisabled`). Release-gated + fail-open; the wire allowlist is in `docs/reference/telemetry.md` |
| `GET /api/webui/notices` → `{ announcements, versions, unavailable, fetchedAt }` | `server/index.ts` via `server/notices.ts` | Product notices (release notes + announcements) proxied from the hub's **public** feeds with a cached, fail-open, per-feed last-good read; no key, not gated on telemetry. See `docs/reference/notices.md` |
| `POST /api/webui/settings/restart` | `server/index.ts` + `server/setup.ts` | Detached restart (stop self + start new) so config changes apply |
| `GET /api/webui/update/check` → `{ current, latest?, updateAvailable, channel, unavailable?, error? }` | `server/index.ts` | Proxy-local update probe (no engine route): fetches the npm registry `latest` (5s timeout) and reports the running `channel` (`dev`/`binary`/`published`). A failed probe answers **200** with `unavailable:true` — a soft state, never an error |
| `POST /api/webui/update` → `{ ok, updating }` | `server/index.ts` + `server/setup.ts` | Detached `update` CLI (resolves the latest published version + restarts), mirroring `settings/restart`. Applies on the **published** channel; a dev checkout / compiled binary logs + no-ops |
| `GET /api/shelf/list` | `server/shelf.ts`, mounted by `server/index.ts` after the auth gate | Read-only shelf listing: `dir` for a directory or `q` for a recursive search; `flat=0` (now the default) skips the recursive flat walk the UI never reads |
| `GET /api/shelf/file/*` | `server/shelf.ts` | Read-only shelf bytes under the frozen prefix. Inert media (raster image / video / audio / PDF) inline; active types forced to download; traversal + symlink (O_NOFOLLOW → `/proc/self/fd` realpath) proof |

Loader behavior: user dir → project dir → shipped dir precedence (same id =
same swap point, higher wins); `manifest.json` `{ id?, name?, description?,
disabled?, settings?, requires?, capabilities? }`;
browser entry candidates `index.tsx`/`index.ts`/`main.tsx`/`main.ts`
(legacy `main.tsx`-only folders still load); `server.ts` modules stat-polled
(2s) and cache-busted re-imported with pollers stopped before swap; `/api/*`
passthrough wrapped by `onRequest`/`onResponse` middleware; the recorder's
always-on engine subscription tapped via `onEvent` (headless, survives closed
tabs); per-extension persistent KV (`server/ext/kv.ts`). Browser side:
declared settings resolve/persist per id (`src/lib/extSettings.ts` via `extKv`)
and are schema-rendered in Settings › Extensions; unmet `requires` and
malformed schema shapes surface as visible diagnostics
(`src/lib/extensionDiagnostics.ts`).

## Client-only — valid routes, no dedicated UI (by decision)

| API group | Paths | Client | Reason |
| --- | --- | --- | --- |
| one-shot generate | `POST /api/experimental/generate` | `api.generate` | Stateless one-shot generation without session/tools — chat (`session/prompt`) supersedes it. Called from plugin/tool contexts (`ctx.generate.text`) where needed. Moved from `/api/generate` (legacy path kept as a 404/405 fallback) |
| `GET /api/reference` | `v2.reference.list` | `api.referenceList` | Engine reference bookkeeping (local/git references) — opaque internals, no user action. |
| `GET /api/debug/location`, `DELETE /api/debug/location` | `v2.debug.location.*` | proxied only | Debug — evict loaded location. |
| `GET /api/experimental/session/{id}/log` | `v2.session.log` | `api.sessionLogHead` | Engine's DURABLE per-session event log with an aggregate-seq cursor. Spike-verified (2026-08-31, `scripts/uitest/spike-v2-log.ts`): durable across process lifetimes (an 8-day-old session serves its head seq), `follow=false` returns a `log.synced` head marker for ANY `after`, but `follow=true` streams ZERO bytes on beta-18684 — no replay, no tail. Wired as dormant cursor tracking (`store.logHeadSeq`, probed on adopt/reconnect); the proxy recorder remains the catch-up channel until a build ships a working follow. |
| `POST /api/rpc/{rpcID}/{method}` | `v2.rpc.call` | proxied only | Generic RPC passthrough — call any registered engine method by id (`Rpc.Input` → `Rpc.Output`). Escape hatch; no UI action exists. Revisit if the engine documents callable methods. |
| `GET /api/experimental/migration/v1` | `v2.experimental.migration.v1.status` | proxied only | V1 migration status. |
| `POST /api/experimental/integration/wellknown` | `v2.experimental.integration.wellknown.add` | integration well-known | Experimental integration discovery. |
| `POST /api/session/{id}/view` | `v2.session.view {idle}` | (add on next client pass) | Marks viewer's idle transition as viewed — spike-verified accepted (204) but with no observable effect on this build, and the §4.4 active-map lag it would address did NOT reproduce (session left `/session/active` within one poll of `wait` resolving). Wire if we add viewed/idle badges or the lag returns. |
| `GET /api/experimental/session/stats` | `v2.session.stats ?from&to&project&timezone&tools` | `api.sessionStats` | **DONE (R6).** v2's `/stats` full-screen route is ported as a core `/stats` page (`StatsPanel`, target `stats.panel`): YTD total tokens as block digits, a year activity calendar with month labels, streak / active days / sessions, loading + error states. Moved from `/api/session/stats` (legacy path kept as a 404 fallback) |
| `GET /api/experimental/session/{id}/instructions/entries` (+ `/{key}` PUT/DELETE) | session instructions | proxied only | Session instruction entries — no user action yet. Moved from `/api/session/{id}/instructions/entries`. |
| `POST /api/experimental/session/import` | session import | proxied only | Import a `SessionTransfer.Data` payload as a session. No webui surface imports sessions yet (the export half is wired). Moved from `/api/session/import`. |
| `GET /api/credential`, `POST /api/credential` | `credential.list/create` | proxied only | Credential list/create. `ConnectDialog` creates credentials through the integration connect flows; the raw credential resource has no standalone surface (relabel/remove/activate are wrapped). |
| `GET /api/info` | `server.info` | `api.serverInfo` | Server version/pid/urls/paths. Replaced `/api/server`; client-only (Settings → Server was de-surfaced) |
| `POST /api/pair`, `GET /auth/connect/{code}` | `server.pair` / `server.connect` | `api.pairCode` (write) | **UI landed (R11).** `PairDialog` (target `pair.dialog`) shows the "This device" URL, all server URLs, a username, a masked password, and a **dependency-free QR** of the public URL. `POST /api/pair` is wrapped as `pairCode`. `GET /auth/connect/{code}` is outside the proxy's `/api/*` prefix and is redeemed by the *phone* against the engine, so it is display-only here |
| `POST /api/location/reload` | `location.reload` | proxied only | Re-discover the ambient location. No user action. |
| `POST /api/experimental/fs/write` (`?path=`, streamed body) | `experimental.fs.write` | proxied only | Experimental filesystem write. The webui is read-only on the fs surface today (edits go through the agent); revisit if a file editor is built. |
| `POST /api/workspace`, `DELETE /api/workspace/{id}` | **removed upstream** | — | The logical workspace lifecycle routes are gone from 2.0.22. We use `project`/`worktree`; v2's worktree/workspace dialogs are the parity reference (`docs/plans/parity.md` R11). |

### Wrapped but not surfaced — audit 2026-10-07

The 2026-10-07 re-sync re-ran the "reachable from `api.*` with no consumer
anywhere in `src/`" audit. Two different situations hide behind that, and they
need different responses:

- **Deliberately de-surfaced (not a gap).** The Settings tabs for WebSearch,
  Config and Server were **removed on purpose** as purely informational —
  display-only panels that didn't earn their place. Revisit only where a route
  powers a real *action* rather than a readout.
- **Genuine gaps.** Wrapped but never wired anywhere — these need a UI or an
  explicit reason row.

| Client method | Route | Status |
| --- | --- | --- |
| `api.pluginList` (+ `pluginCheck`/`pluginUpdate`) | `GET /api/plugin`, `POST /api/plugin/{check,update}` | **Wired (P4).** Settings → Plugins (`PluginsSection`, target `settings.plugins`) lists plugins with source/features/state and *acts* — check for updates, update one/all, with per-row progress and the failed state's error. No toggle: the engine has no enable/disable route. |
| `api.configGet` | `GET /api/config` | **Consumed (R12).** The global config document is now read by Settings › Shell (`ShellSection`) to show the current `shell` value; `configPreferencesUpdate`/`configShells` are wired there too. ("Settings → Config" remains a de-surfaced read-only dump.) |
| `api.websearch`, `api.websearchProviders` | `GET /api/websearch/provider`, `POST /api/websearch` | **De-surfaced (deliberate).** "Settings → WebSearch" was informational. Kept wrapped for a future in-chat search surface, not a settings panel. `ToolCard`'s "websearch" label is display only. |
| `api.mcpResource` | `GET /api/mcp/resource` | **Still client-only.** Add/remove/connect/disconnect are wired in `McpIndicator`; the resource+templates catalog has no surface yet (it belongs in an expanded server row). |
| `api.providerGet` | `GET /api/provider/{id}` | **Still client-only.** `ConnectDialog` lists providers and now relabels/removes credentials, but does not open a single provider's detail. |
| `api.vcsBranches` | `GET /api/vcs/branch` | **Wired (R7).** Powers the diff viewer's searchable local+remote base-branch picker; the chosen base is remembered until the viewer closes. |
| `api.shellGet` | `GET /api/shell/{id}` | **Genuine gap (minor).** `shellList`/`shellOutput`/`shellDelete` are wired; single-fetch is not. |
| `api.serverInfo` | `GET /api/info` | **De-surfaced (deliberate).** "Settings → Server" was informational; the connection footer reads `/api/webui/status` (`api.health`). |
| `api.sessionQuestionList`, `api.questionRequestGet` (+ reply/reject) | legacy `question` routes (not in the snapshot; 404 live) | **Legacy.** Superseded by the event + form channel; the reply/reject halves are still called by `store.replyQuestion`/`rejectQuestion` for any question channel the engine emits, but drop to the form fallback. No documented route exists on 2.0.22. |

## Experimental / infra — not surfaced in webapp

| API group | Paths | Notes |
| --- | --- | --- |
| persistent-pty | `GET/POST /api/experimental/persistent-pty/*`, `GET/POST /api/experimental/session/{id}/terminal` | Prototype persistent PTY (`server.experimental.persistentPty.*`) — keep the location-scoped `pty` group in `src/api/client.ts` as canonical; revisit if promoted from experimental. |
| experimental config | `PATCH /api/experimental/config` | Global config patch (only `shell` today). Wrapped as `configPreferencesUpdate`. |

## Removed upstream (since the 2026-09-15 snapshot) — nothing to wrap

These paths were in the prior snapshot and are gone from 2.0.22. Each is either
already compensated by a current route or has no replacement (recorded so it is
not re-litigated):

| Removed path | Compensation |
| --- | --- |
| `GET /api/health`, `GET /api/server` | `api.health` reads the proxy-owned `/api/webui/status`; `api.serverInfo` reads `GET /api/info` |
| `GET /api/project/current` | derive from `GET /api/location` (`Location.PublicInfo.project`) |
| `POST /api/session/{id}/rename` | `PATCH /api/session/{id}` `{title}` |
| `POST /api/session/{id}/revert/clear` | `DELETE /api/session/{id}/revert` |
| `PUT /api/session/{id}/permission/rules` | `PATCH /api/session/{id}` `{permissions}` |
| `POST /api/session/{id}/inbox/{id}/steer`, `.../queue` | `PATCH /api/session/{id}/inbox/{id}` `{delivery}` |
| `GET /api/session/{id}/wait`, `GET /api/session/{id}/export`, `POST /api/session/{id}/skill`, `/api/session/import`, `/api/session/stats`, `/api/session/{id}/instructions/entries[/{key}]`, `/api/generate`, `/api/config/preferences`, `/api/mcp/*` (write/action), `/api/plugin/await-activation` | moved under `/api/experimental/*` (see the route tables) |
| `GET /api/session/{id}/form/{id}/state` | `GET /api/session/{id}/form/{id}` carries `state` (typed `FormDetail.state`) |
| `POST /api/session/{id}/form/{id}/cancel` | `DELETE /api/session/{id}/form/{id}` |
| `POST /api/form/request` | `GET /api/form` |
| `GET /api/vcs/branches` | `GET /api/vcs/branch` |
| `PATCH /api/shell/{id}/timeout` | **none** — timeout is create-time only (`shellCreate`); the client wrapper and the set-timeout UI were removed |
| `POST /api/plugin/await-activation` | **none** — `plugin/update` already waits for activation |
| `POST /api/service/stop` | **none** — no UI; the process is managed by `setup`/the lifecycle plugin. `api.serviceStop` was dropped |
| `/api/workspace`, `/api/workspace/{id}` | **none** — we use `project`/`worktree` |

## What changed vs previous snapshot (123 → 116 paths)

The prior snapshot (`2026-09-15`, engine **2.0.3**) was 123 paths / 241 schemas.
Regenerated `2026-10-07` against engine **2.0.22**: **116 paths / 255 schemas**.
`diff-openapi --check` now exits 0. The moves/fixes are the "Removed upstream"
and "Client-only" tables above; the drift tooling summary was:

- **ONLY_LIVE (21)** — new upstream routes: `/api/credential` (list/create),
  `/api/info`, `/api/pair`, `/auth/connect/{code}`, `/api/location/reload`,
  `/api/experimental/config`, `/api/experimental/fs/write`,
  `/api/experimental/generate`, `/api/experimental/mcp/{server}[/connect|/disconnect]`,
  `/api/experimental/session/import`, `/api/experimental/session/stats`,
  `/api/experimental/session/{id}/export`, `/api/experimental/session/{id}/skill`,
  `/api/experimental/session/{id}/wait`,
  `/api/experimental/session/{id}/instructions/entries[/{key}]`, `/api/form`,
  `/api/session/{id}/revert`, `/api/vcs/branch`.
- **ONLY_SNAP (28)** — removed (see "Removed upstream").
- **MODIFIED (88)** — mostly schema inlining; the behaviourally relevant ones are
  the shape/body/query changes documented throughout this file (permission reply
  body `reply`→`decision`; interrupt query `continue`→`resume`; command field
  `command`→`name`; `Command.Info`/`Skill.Info`/`Provider.Info` narrowing; the
  session create/patch `permissions` field).
- **Schemas:** +24 / −10. Notable additions: `Form.Detail`, `Form.Answer_1`,
  `Credential.*`, `Config.Patch`, `Config.Model.*`, `Location.PublicInfo`,
  `Location.PublicRef`, `Mcp.Protocol`, `PairingCode`, `PairingSession`,
  `ServerInfo`, `FileSystem.Write`, `Connection.Status`. New message variant
  `Session.Message.Idle` (typed as `IdleMessage` in `src/api/types.ts`).

**Live smoke (2026-10-07, throwaway sessions created + deleted).** Every changed
client method was exercised through `src/api/client.ts` against the live engine:

| Method | Route exercised | Result |
| --- | --- | --- |
| `sessionPermissionRules` | `PATCH /api/session/{id}` `{permissions:[]}` | 204 |
| `renameSession` | `PATCH /api/session/{id}` `{title}` | 204 (title read back) |
| `activateSkill` | `POST /api/experimental/session/{id}/skill` `{id}` | 404 `SkillNotFoundError` for a bogus id → route+body accepted |
| `exportSession` | `GET /api/experimental/session/{id}/export` | 200 `SessionTransfer.Data` |
| `sessionWait` | `POST /api/experimental/session/{id}/wait` | 204 |
| `interrupt(true)` | `POST /api/session/{id}/interrupt?continue&resume` | 200 |
| `revertClear` | `DELETE /api/session/{id}/revert` | 204 |
| `inboxSteer` | `PATCH /api/session/{id}/inbox/msg_…` `{delivery}` | 409 (delivery validation reached) → route+body accepted |
| `formState` / `cancelForm` | `GET`+`DELETE /api/session/{id}/form/{id}` | 200 (`state.status:"pending"`) / 204 |
| `pendingForms` | `GET /api/form` | 200 |
| `vcsBranches` / `vcsBase` / `vcsDiff` | `GET /api/vcs/branch|base|diff` | 200 (`["master","origin","origin/master"]`, base ref, diff files) |
| `projectCurrent` | derived from `GET /api/location` | 200 (id/canonical/directory) |
| `serverInfo` | `GET /api/info` | 200 (`version:"2.0.22"`) |
| `generate` | `POST /api/experimental/generate` | 200 `{data:{text}}` |
| `mcpDisconnect`/`mcpDelete` | `DELETE`/`POST /api/experimental/mcp/{server}` | 404 `McpServerNotFoundError` (route exists) |
| `pluginAwaitActivation` | legacy route gone | resolves (404 swallowed) |
| `configPreferencesUpdate` | `PATCH /api/experimental/config` | route verified (`{}` → 400 `Missing key ["shell"]`); **not** written live to avoid mutating the user's global config |
| `shellTimeout` (removed) | `PATCH /api/shell/{id}/timeout` | 404 — removed upstream; wrapper + set-timeout UI deleted (timeout is create-time only) |

## Previous snapshot change (116 → 123 paths)

Snapshot `docs/reference/openapi.json` at `2026-09-01` was 116 paths.
Refreshed to **123** (live as of `2026-09-15`, engine reports 2.0.3). All new
client methods were smoke-tested live (each returns the documented status).

**Added (9)** — all wrapped:

- `GET/PATCH /api/config/preferences`, `GET /api/config/shell` → `configPreferences`, `configPreferencesUpdate`, `configShells`. Note: preferences come from the highest-precedence **global** config document — there is no `location` parameter.
- `POST /api/plugin/check`, `POST /api/plugin/update`, `POST /api/plugin/await-activation` → `pluginCheck`, `pluginUpdate`, `pluginAwaitActivation`. The plugin-update flow (was missing entirely).
- `GET /api/session/{id}/diff` → `sessionDiff`. **Turn-scoped** per-file diffs (idle-marker to idle-marker; steered prompts fold into the same turn), distinct from the repo-scoped `/api/vcs/diff`. This is the TUI diff viewer's third source.
- `PUT /api/session/{id}/permission/rules` → `sessionPermissionRules` (204). Session rules evaluate *after* the agent's; last match wins.
- `GET/POST/DELETE /api/worktree`, `POST /api/worktree/refresh` → `worktreeList/Create/Remove/Refresh`.

**Removed (2) — breaking, but unused by us:**

- `GET/POST/DELETE /api/worktree/{projectID}` and `POST /api/worktree/{projectID}/refresh` are gone, replaced by the **project-scoped** `/api/worktree` (the project id moves into the query on the list and into the create/remove bodies).
- `PATCH /api/session/{id}/message/{messageID}` is gone; that path now serves only `GET`.

**Modified (7):**

- `POST /api/session` accepts `permissions` (`Permission.Ruleset | null`) → `createSession` widened.
- `GET /api/session/{id}/message` accepts a `type` filter (10 values) before pagination → `messages`/`messagesWithCursor` widened. Re-send the filter on every page.
- `PATCH /api/project/{id}` accepts `canonical` → `projectUpdate` added.
- `GET /api/fs/read/*` documents a `404 FileNotFoundError` (new schema).
- `GET /api/fs/list` description/behaviour: absolute paths and parents/siblings outside the location dir now list, while entry paths stay relative to the location.
- `DELETE /api/session/{id}` 404 schema dedupe (`anyOf` → `$ref`) — cosmetic.

## Previous snapshot change (115 → 116 paths)

Snapshot `docs/reference/openapi.json` at `2026-08-31` was 115 paths.
Refreshed to 116 (live as of `2026-09-01`):

- Added 115 → 116: `POST /api/rpc/{rpcID}/{method}` (`v2.rpc.call`) — generic
  RPC passthrough into the engine (call any registered method by id, `Rpc.Input →
  Rpc.Output`). Documented as proxied-only below; no UI action exists for it.
- Implemented from the previous 111 → 115 batch: `GET /api/vcs/base` (client +
  wired into FileExplorer diff) and `POST /api/credential/{id}/activate`
  (client + activate button in Settings → Integrations). Still unimplemented:
  the experimental persistent-pty/terminal routes (see the experimental table).

### Client correctness fixes (no snapshot change)

- `POST /api/session/{id}/command` takes `{name, text, files?, agents?,
  skills?, delivery?}` on the current engine (**`name`**; older engines used
  `command`) with **`text` required** — not the `arguments` key the pinned
  `@opencode/client` protocol types still declare. `api.runCommand` sends
  **both** `name` and `command` plus `text`; the engine's runtime ignores the
  key it does not know (verified live: `{name, command, text}` → 204 + expanded
  template).
- Attachment `files` only become prompt content for
  `image/png|jpeg|gif|webp`, `application/pdf`, `text/plain` and
  `application/x-directory` — every other mime is **silently dropped** by the
  engine. The composer therefore stages only those four image types
  (paste/drop/picker/`@`-pick), reports anything else instead of dropping it,
  and downscales to the engine's `image.*` defaults (2000×2000 / 5 MiB base64)
  before send.

## Previous snapshot change (99 → 115)

Snapshot `docs/reference/openapi.json` at `2026-08-16` was 99 paths (`@opencode/client@0.0.0-next-17444`).
Refreshed to 111 (`2026-08-26`), then to 115 (2026-08-31):

- Added 111 → 115: `POST /api/credential/{id}/activate`, `POST /api/experimental/persistent-pty/handoff`,
  `GET /api/experimental/session/{id}/terminal/read`, `GET /api/vcs/base`. None surfaced in the webapp yet.

- Added: `GET /api/session/stats`, `POST /api/session/{id}/view` (session group),
  `POST /api/workspace` + `DELETE /api/workspace/{id}` (new `workspace` tag),
  `GET /api/vcs/branches`, `PATCH /api/project/{id}` (`v2.project.update`),
  9× `persistent-pty` (`server.experimental.persistentPty.*`).
- Semantic change: `POST /api/session/{id}/interrupt` now returns `200 {SessionInterruptResponse {interrupted: bool}}` not `204` — description updated to resume `steering + next-in-line control items (manual compaction, moves)` while queued prompts stay parked.
- Cosmetic across all 99 retained paths: bodies inlined — `Union_*`/`Objects_*`/`Arrays_*` refs replaced by explicit `anyOf`/`items`. No `ONLY_SNAP` paths were removed; new schemas: `SessionStats.*`, `WorkspaceDestroyResult`, `SessionInterruptResponse`, `CommandExecutionErrorEncoded`, etc.

## Dual stack (Promise vs Effect) — no webapp impact

New build docs (`opencode.ai/v2/docs/build/*`) ship an **optional** Effect variant of the
same contract:

- `packages/client/src/generated` (Promise/`fetch`) vs `generated-effect` (`Effect` + `HttpClient`/`@opencode-ai/schema`)
- `packages/plugin/src/v2/promise` vs `v2/effect`, `packages/sdk` pinned `effect@4.0.0-beta.83`

Webapp stays on Promise: `server/index.ts` `Service.ensure()` + `src/api/client.ts` `request<T>`.
The `/effect` entrypoints are additive — same OpenAPI at `/openapi.json`. Building a server plugin
or embedding via SDK would pick one style; webapp contributors ignore it. Doc ref:
`opencode.ai/v2/docs/build` (Build overview) · `/build/plugins` + `/build/plugins/cli` ·
`/build/client` (`@opencode/client@beta`) · `/build/sdk` (`@opencode-ai/sdk@dev`).

## Keeping this map honest — when the diff grows

The full procedure (diagnose → regenerate → resync → re-verify → rewrite these
rows) is **`docs/runbooks/engine-update.md`**. In short: `bun run
scripts/fetch-openapi.ts`, review `git diff docs/reference/openapi.json`, add the
client methods/types, decide UI (a component/extension, or a **client-only with
reason** row here), and keep `bun run typecheck` green. No new deps without
justification (`AGENTS.md`, "Rules for editing").

```
bun run scripts/fetch-openapi.ts      # refresh snapshot from live service
bun run scripts/diff-openapi.ts       # pretty drift summary
bun run scripts/diff-openapi.ts --json
bun run scripts/diff-openapi.ts --check   # exit 1 on drift (CI)
git diff docs/reference/openapi.json  # raw contract diff
```
