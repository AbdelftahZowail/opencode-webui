# API coverage — have / don't have / why

Source of truth for the HTTP contract: `docs/reference/openapi.json`
(snapshot of the running service's `/openapi.json`, 123 paths as of this doc).
Refresh: `bun run scripts/fetch-openapi.ts` (via `Service.ensure()` like the proxy).
Diff against live: `bun run scripts/diff-openapi.ts` (also `--json`, `--check` for CI).
Raw diff: `git diff docs/reference/openapi.json`.

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
> **not** document. Verified live: those paths answer on the 2.0.3 engine while
> their `/api/*` counterparts 404.
>
> **It is still out of scope.** `@opencode/client` on branch `v2` declares 115
> endpoints and all of them are `/api/*` — the v2 TUI never touches the legacy
> surface, which exists for the **v1** TUI. `server/index.ts` forwarding only
> `/api/*` is therefore correct, no proxy bridge is wanted, and the legacy-only
> features the v1 TUI had (todos, LSP/formatter status, session share, console
> orgs) are **not** v2 capabilities. See `docs/tui-parity-roadmap.md`.

## Have — wired in the webapp

| API group | OpenAPI paths | Client | UI |
| --- | --- | --- | --- |
| health/server | `GET /api/health`, `GET /api/server` | `api.health`, `api.serverInfo` | Connection footer (reads `/api/webui/status` via `api.health`). `api.serverInfo` is client-only — the Settings → Server tab was deliberately de-surfaced as informational |
| session lifecycle | `GET/POST /api/session`, `GET/DELETE /api/session/{id}`, `GET /api/session/active`, `POST import`, `GET export`, `POST fork`, `POST rename`, `POST move`, `POST compact`, `POST wait` | `listSessions`, `createSession`, `getSession`, `deleteSession`, `activeSessions`, `forkSession`, `renameSession`, `exportSession`, `compactSession`, `sessionWait` (via store) | Sidebar, session page, session actions (rename/fork/export/compact/move via inbox) |
| prompt/command/skill/synthetic/shell | `POST /api/session/{id}/prompt`, `POST command`, `POST skill`, `POST synthetic`, `POST shell`, `POST generate` (session-scoped), `GET context`, `GET/PUT/DELETE instructions/entries`, `GET message`, `GET message/{id}` | `prompt`, `promptWithFiles`, `runCommand`, `activateSkill`, `sessionShell`, `sessionGenerate`, `messages`, `inbox*` | Composer, slash menu, `@` file refs, `!` bash, skill picker, shell panel |
| events (SSE) | `GET /api/event` | `src/api/events.ts` | `store.handleEvent` live streaming (queued→running→ordered parts, poll fallback) |
| permissions/forms/questions | `GET /api/permission/request`, `GET/DELETE /api/permission/saved[/{id}]`, `GET/POST /api/session/{id}/permission*`, `GET /api/form/request`, `GET/POST /api/session/{id}/form*`, legacy `question` routes | `pendingPermissions`, `replyPermission`, `permissionSavedList/Delete`, `pendingForms`, `sessionForms` (per-session backfill), `formState/replyForm/cancelForm`, `question*` | `PendingRequestsPanel` (composer-slot FIFO panel per focused session + corner chip for others), queue in store. Ground truth (2026-08-26, `scripts/uitest/probe-*.ts`): GLOBAL form listing can omit a pending question-form indefinitely under load — mounted sessions are polled per-session and unioned by id; `/form/{id}/state` is authoritative but 404s transiently right after creation (60s newborn grace before trusting it); question multiplicity = field type (`multiselect` ⇒ array answers, `string` ⇒ one string); no native question REST routes on this engine (events only). Permission listing semantics unverified live (deployment auto-allows) — refresh unions by id, removal event-driven. `SessionInfo.permissions` now typed (the engine already returned it). **P4 UI:** session menu → "Permission rules…" edits the session ruleset (target `permission.rulesEditor`) and lists the project's saved ("always allow") rules with per-row removal (`permissionSavedList/Delete`) |
| inbox/steering | `GET /api/session/{id}/inbox`, `DELETE inbox/{id}`, `POST steer/queue` | `inboxList/Queue/Steer/Delete`, `inboxPrompt`, `prompt/promptWithFiles` (optional `delivery`) | Explicit STEER vs QUEUE system: busy sends become tracked inbox rows in `QueueStrip` (toggle/send-now/cancel), reconciled by `session.inbox.*` events + poll; queue-drain failsafe on turn end. `InboxPanel` unchanged |
| revert | `POST revert/stage`, `POST revert/clear`, `POST revert/commit` | `revertStage/Clear/Commit` | `/undo` `/redo`, `applyRevertView` cut of transcript |
| agent/model/command/skill catalog | `GET /api/agent`, `GET /api/agent/{id}`, `GET /api/model`, `GET /api/model/default`, `GET /api/command`, `GET /api/skill` | `agents`, `models`, `modelDefault`, `commands`, `skills` | Pickers (`Pickers.tsx`), command palette, skill picker, variants; `resolveDefaultModel` uses `modelDefault` so new sessions match the engine/TUI default |
| provider/integration/credential | `GET /api/provider`, `GET /api/provider/{id}`, `GET /api/integration`, `POST connect/key|oauth|command`, `PATCH/DELETE/POST-activate /api/credential/{id}` | `providerList/Get`, `integration*`, `credentialPatch/Delete/Activate` | `ConnectDialog` (`/connect`, via `/connect` or the palette): integrations catalog, API-key/OAuth/CLI-command connect, stored credentials + **activate / relabel / remove** (P4). **Not a Settings tab** — Settings is Extensions / Plugins / Security / App(phone) |
| mcp | `GET/PUT/DELETE /api/mcp*`, `POST connect/disconnect`, `GET resource` | `mcpList/Put/Delete/Connect/Disconnect/Resource` — every wrapper **accepts** `location` (the deployment is single-project, so the indicator deliberately uses the ambient scope) | `McpIndicator` header popover: per-server status, connect/disconnect, **add** (local command / remote url) and **remove** with a two-step confirm (P4). Deliberately ADD-only — there is no single-server read route, so an "edit" would silently clobber the existing config (PUT replaces). `mcpResource` stays client-only. **Wave 0 fix:** `mcpPut` sent **PATCH** where the route is **PUT** (and the wrappers now thread `location`), both corrected against the snapshot |
| filesystem/location/project | `GET /api/fs/read/*`, `GET /api/fs/list`, `GET /api/fs/find`, `GET /api/location`, `GET /api/project`, `GET /api/project/current`, `PATCH /api/project/{id}` | `fsRead/ReadBytes/List/Find`, `location`, `project*`, `projectUpdate` | FileExplorer, workspace picker, path chips (`projectUpdate` is client-only) |
| vcs | `GET /api/vcs`, `GET /api/vcs/status`, `GET /api/vcs/diff` (+ `base` param), `GET /api/vcs/branches`, `GET /api/vcs/base` | `vcsStatus/Diff/Base`, `vcsQuery` helper | FileExplorer diff (infers the review base via `vcsBase` and passes its `ref` to `vcsDiff`, so ambiguous Git history doesn't need an explicit base), VCS status badge |
| pty/shell | `GET/POST /api/pty`, `GET/PUT/DELETE /api/pty/{id}`, `POST connect-token`, `GET connect`, `GET/POST /api/shell*` | `pty*`, `shell*` | Shell panel, `TerminalView.tsx` (xterm) via websocket proxy |
| permissions (session rules) | `PUT /api/session/{id}/permission/rules`, `permissions` on `POST /api/session` | `sessionPermissionRules`, `createSession({permissions})` | **DONE (P4).** Session menu → "Permission rules…" opens an order-aware editor (add/remove/reorder, all three effects, `*` globs). The engine evaluates session rules AFTER the agent's and the LAST match wins, which the editor states and makes legible; save is one PUT (replace semantics) followed by a session re-read |
| session diff (turn-scoped) | `GET /api/session/{id}/diff?from&to&context` | `sessionDiff` | **DONE (P2).** `DiffViewer` (FileExplorer → "Review", target `diff.viewer`): three sources — last turn / working tree / branch base — with a changed-file tree, per-file (n/p) and per-hunk (j/k) navigation, split vs unified, and local-only review markers. Distinct from `vcs` diff: this is "what did ONE TURN change". A turn runs idle marker to idle marker, so steered prompts fold into one turn — verified live on this session. `context` is requested (12) because the engine's default is a full-file patch (192 KB for a 4.5k-line file) |
| worktree | `GET/POST/DELETE /api/worktree`, `POST /api/worktree/refresh` (+ `location` query) | `worktreeList/Create/Remove/Refresh` | **DONE (P3).** `WorktreePanel` in the WorkspacePicker dropdown: list / create / remove (force, two-step confirm) / refresh; "Use" moves the session into the worktree via the shared `moveSessionToDirectory`. Location-scoped; the old `{projectID}` routes were **removed upstream**. **Response-shape fix:** `Worktree.List` is a **bare array** and `Worktree.Info` a **bare object** — the P0 wrapper wrongly assumed `{ data }`, which crashed the panel until corrected (the store now also tolerates a non-array) |
| config preferences | `GET/PATCH /api/config/preferences`, `GET /api/config/shell` | `configPreferences`, `configPreferencesUpdate`, `configShells` | **Client wrapped, UI still pending (P4).** Shell selection has no home yet: it is a global preference (no `location`) and the Settings tab set is Extensions / Plugins / Security / App, so it is a deliberate deferral rather than an oversight — a "Terminal" settings host is the follow-up |
| plugin updates | `POST /api/plugin/check`, `POST /api/plugin/update`, `POST /api/plugin/await-activation` | `pluginCheck`, `pluginUpdate`, `pluginAwaitActivation` | **DONE (P4).** Settings → Plugins (target `settings.plugins`): every plugin with its source kind, features and state, plus "Check for updates" / per-package check / update (+ update-all for outdated). `updatePlugins` awaits activation and then re-reads the catalog (activation completing does NOT mean success — `state` is the authority). **No enable/disable route exists** upstream: there is nothing to toggle, so no toggle is offered. All four source kinds are handled; the live catalog observed only `builtin` and `local`, so the `package` / `sdk` branches and the "update available" affordance are code-verified but not exercised live |
| websearch/config | `GET /api/websearch/provider`, `POST /api/websearch`, `GET /api/config` | `websearch*`, `configGet` | **No UI** (client-only) — see the client-only table |
| interrupt/background | `POST /api/session/{id}/interrupt?continue`, `POST background` | `interrupt`, `flushSteersNow` (`continue=true`: interrupt + resume steering, queue stays parked), `sessionBackground` | Esc two-step interrupt, QueueStrip "interrupt & send now", Ctrl+B background subagents |

## Webui extension surface (proxy-owned — not engine OpenAPI, no snapshot drift)

These routes are served by the proxy itself (`server/index.ts`, `server/ext/`,
`server/userExtensions.ts`) for the extension system
(`docs/extension-system-spec.md` §6/`§8`, authoring guide
`webui-extensions/README.md`). They never appear in `docs/reference/openapi.json`
and are intentionally excluded from `scripts/diff-openapi.ts`.

| Endpoint | Served by | Purpose |
| --- | --- | --- |
| `GET /api/webui/extensions` → `{ data: [{ id, source, origin?, name?, description?, url?, domUrl?, disabled?, settings?, requires?, capabilities? }], version }` | `server/index.ts` via `server/userExtensions.ts` discovery | Extension manifest: one loader, three sources (user → project → shipped); folder presence + manifest `disabled` is the only gating; carries declared settings/`requires` through for the Settings card |
| `GET /api/webui/extensions/events` (SSE) | `server/index.ts` manifest listeners | Manifest push channel: one `{ type: "webui.extensions", version }` event per change + hello on subscribe; the page re-fetches the manifest and same-id-swaps bundles (replaces the old 8s poll) |
| `GET /api/webui/extensions/{id}/bundle.js?v=mtime` | `server/index.ts` via `Bun.build` | Per-extension browser bundle (`index.tsx` entry), ESM cache-busted on the query so hot edits repaint live with no refresh |
| `/api/webui/ext/<id>/…` | `server/ext/registry.ts` `dispatchExtRequest` | Proxy-stratum `server.ts` routes, auto-mounted and namespaced per extension (unknown id/route never falls through to the engine) |
| `GET /api/webui/config` → `{ version, reportRepo }` | `server/index.ts` | Pinned version exposure for the agent skill (`skills/webui/SKILL.md` links pin to the released tag) |
| `GET/PUT /api/webui/settings` | `server/index.ts` via `server/config.ts` | Serve/security settings: file + effective + per-key source, exposure analysis, restart delta; PUT validates and can require `confirm`. Passwords are hashed/redacted. |
| `POST /api/webui/settings/restart` | `server/index.ts` + `server/setup.ts` | Detached restart (stop self + start new) so config changes apply |

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
| `POST /api/generate` | `v2.generate.text` | `api.generate` | Stateless one-shot generation without session/tools — chat (`session/prompt`) supersedes it. Called from plugin/tool contexts (`ctx.generate.text`) where needed. |
| `GET /api/reference` | `v2.reference.list` | `api.referenceList` | Engine reference bookkeeping (local/git references) — opaque internals, no user action. |
| `GET /api/debug/location`, `DELETE /api/debug/location` | `v2.debug.location.*` | proxied only | Debug — evict loaded location. |
| `GET /api/experimental/session/{id}/log` | `v2.session.log` | `api.sessionLogHead` | Engine's DURABLE per-session event log with an aggregate-seq cursor. Spike-verified (2026-08-31, `scripts/uitest/spike-v2-log.ts`): durable across process lifetimes (an 8-day-old session serves its head seq), `follow=false` returns a `log.synced` head marker for ANY `after`, but `follow=true` streams ZERO bytes on beta-18684 — no replay, no tail. Wired as dormant cursor tracking (`store.logHeadSeq`, probed on adopt/reconnect); the proxy recorder remains the catch-up channel until a build ships a working follow. |
| `POST /api/rpc/{rpcID}/{method}` | `v2.rpc.call` | proxied only | Generic RPC passthrough — call any registered engine method by id (`Rpc.Input` → `Rpc.Output`). Escape hatch; no UI action exists. Revisit if the engine documents callable methods. |
| `GET /api/experimental/migration/v1` | `v2.experimental.migration.v1.status` | proxied only | V1 migration status. |
| `POST /api/experimental/integration/wellknown` | `v2.experimental.integration.wellknown.add` | integration well-known | Experimental integration discovery. |
| `POST /api/session/{id}/view` | `v2.session.view {idle}` | (add on next client pass) | Marks viewer's idle transition as viewed — spike-verified accepted (204) but with no observable effect on this build, and the §4.4 active-map lag it would address did NOT reproduce (session left `/session/active` within one poll of `wait` resolving). Wire if we add viewed/idle badges or the lag returns. |
| `GET /api/session/stats` | `v2.session.stats ?from&to&project&timezone&tools` | (add on next client pass) | Aggregate activity/usage/tool reliability — dashboard/telemetry surface, deliberate follow-up (see Extending checklist). |
| `POST /api/workspace`, `DELETE /api/workspace/{id}` | `v2.workspace.create/destroy` | (add on next client pass) | Logical workspace lifecycle (idempotent create/destroy `{id?, provider}`) — we use `project` today; track for future workspace UI. |

### Wrapped but not surfaced — audit 2026-09-15

The 2026-09-15 audit found these reachable from `api.*` with **no consumer
anywhere in `src/`**. Two different situations hide behind that, and they need
different responses:

- **Deliberately de-surfaced (not a gap).** The Settings tabs for Plugins,
  WebSearch, Config and Server were **removed on purpose** as purely
  informational — display-only panels that didn't earn their place. The old
  "Settings → …" entries this file used to carry were accurate at the time, not
  wrong. Revisit only where a route powers a real *action* rather than a
  readout.
- **Genuine gaps.** Wrapped but never wired anywhere — these need a UI or an
  explicit reason row.

| Client method | Route | Status |
| --- | --- | --- |
| `api.pluginList` (+ `pluginCheck`/`pluginUpdate`/`pluginAwaitActivation`) | `GET /api/plugin`, `POST /api/plugin/{check,update,await-activation}` | **Wired (P4).** Settings → Plugins (`PluginsSection`, target `settings.plugins`) lists plugins with source/features/state and *acts* — check for updates, update one/all, with per-row progress and the failed state's error. No toggle: the engine has no enable/disable route. |
| `api.configGet` | `GET /api/config` | **De-surfaced (deliberate).** "Settings → Config" was a read-only dump. `configPreferences`/`configPreferencesUpdate`/`configShells` are separate and actionable, but still have no home — see the shell-selection note in the route table. |
| `api.websearch`, `api.websearchProviders` | `GET /api/websearch/provider`, `POST /api/websearch` | **De-surfaced (deliberate).** "Settings → WebSearch" was informational. Kept wrapped for a future in-chat search surface, not a settings panel. `ToolCard`'s "websearch" label is display only. |
| `api.mcpResource` | `GET /api/mcp/resource` | **Still client-only.** Add/remove/connect/disconnect are wired in `McpIndicator`; the resource+templates catalog has no surface yet (it belongs in an expanded server row). |
| `api.providerGet` | `GET /api/provider/{id}` | **Still client-only.** `ConnectDialog` lists providers and now relabels/removes credentials, but does not open a single provider's detail. |
| `api.shellGet` | `GET /api/shell/{id}` | **Genuine gap (minor).** `shellList`/`shellOutput`/`shellDelete` are wired; single-fetch is not. |
| `api.serverInfo`, `api.serviceStop` | `GET /api/server`, `POST /api/service/stop` | **De-surfaced (deliberate).** "Settings → Server" was informational; the connection footer reads `/api/webui/status` (`api.health`). `serviceStop` has no UI — the process is managed by `setup`/the lifecycle plugin. |
| `api.sessionQuestionList`, `api.questionRequestGet` | `GET /api/session/{id}/question`, `GET /api/question/request` | Superseded by the event + form channel; the reply/reject halves ARE used by `store.replyQuestion`/`rejectQuestion`. |

## Experimental / infra — not surfaced in webapp

| API group | Paths | Notes |
| --- | --- | --- |
| persistent-pty | `GET/POST /api/experimental/persistent-pty/*`, `GET/POST /api/experimental/session/{id}/terminal` | Prototype persistent PTY (`server.experimental.persistentPty.*`) — keep the location-scoped `pty` group in `src/api/client.ts` as canonical; revisit if promoted from experimental. |

## What changed vs last snapshot (116 → 123 paths)

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

- `GET/POST/DELETE /api/worktree/{projectID}` and `POST /api/worktree/{projectID}/refresh` are gone, replaced by the **location-scoped** `/api/worktree`. Nothing in `src/` called them, so no code change was needed beyond the doc row.
- `PATCH /api/session/{id}/message/{messageID}` is gone; that path now serves only `GET`. We never called it.

**Modified (7):**

- `POST /api/session` accepts `permissions` (`Permission.Ruleset | null`) → `createSession` widened.
- `GET /api/session/{id}/message` accepts a `type` filter (10 values) before pagination → `messages`/`messagesWithCursor` widened. Re-send the filter on every page.
- `PATCH /api/project/{id}` accepts `canonical` → `projectUpdate` added.
- `GET /api/fs/read/*` documents a `404 FileNotFoundError` (new schema).
- `GET /api/fs/list` description/behaviour: absolute paths and parents/siblings outside the location dir now list, while entry paths stay relative to the location.
- `DELETE /api/session/{id}` 404 schema dedupe (`anyOf` → `$ref`) — cosmetic.

**New schemas (12):** `Config.Preferences`, `Config.PreferencesPatch`, `Config.Worktree`, `ConfigShell.Option`, `FileNotFoundErrorEncoded`, `Provider.Compaction`, `Session.Message.Idle`, `Session.Message.ProviderState_5`, `Session.ProviderContext`, `Session.ProviderContext.Provenance`, `Worktree.CreateInput`, `Worktree.RemoveInput`.

## Previous snapshot change (115 → 116 paths)

Snapshot `docs/reference/openapi.json` at `2026-08-31` was 115 paths.
Refreshed to 116 (live as of 2026-09-01):

- Added 115 → 116: `POST /api/rpc/{rpcID}/{method}` (`v2.rpc.call`) — generic
  RPC passthrough into the engine (call any registered method by id, `Rpc.Input →
  Rpc.Output`). Documented as proxied-only below; no UI action exists for it.
- Implemented from the previous 111 → 115 batch: `GET /api/vcs/base` (client +
  wired into FileExplorer diff) and `POST /api/credential/{id}/activate`
  (client + activate button in Settings → Integrations). Still unimplemented:
  the experimental persistent-pty/terminal routes (see the experimental table).

### Client correctness fixes (no snapshot change)

- `POST /api/session/{id}/command` takes `{command, text, files?, agents?,
  skills?, delivery?}` with **`text` required** — not the `arguments` key the
  pinned `@opencode/client` protocol types still declare. Sending
  `arguments` fails validation with `Missing key at ["text"]`, which is what
  made every leading-slash message error. `api.runCommand` now sends `text`
  (the command's argument string; `""` when there are none).
- Attachment `files` only become prompt content for `image/png|jpeg|gif|webp`,
  `application/pdf`, `text/plain` and `application/x-directory` — every other
  mime is **silently dropped** by the engine. The composer therefore stages
  only those four image types (paste/drop/picker/`@`-pick), reports anything
  else instead of dropping it, and downscales to the engine's `image.*`
  defaults (2000×2000 / 5 MiB base64) before send.

## Previous snapshot change (99 → 115)

Snapshot `docs/reference/openapi.json` at `2026-08-16` was 99 paths (`@opencode/client@0.0.0-next-17444`).
Refreshed to 111 (`2026-08-26`), then to 115 (2026-08-31):

- Added 111 → 115: `POST /api/credential/{id}/activate`, `POST /api/experimental/persistent-pty/handoff`,
  `GET /api/experimental/session/{id}/terminal/read`, `GET /api/vcs/base`. None surfaced in the webapp yet.

- Added: `GET /api/session/stats`, `POST /api/session/{id}/view` (session group),
  `POST /api/workspace` + `DELETE /api/workspace/{id}` (new `workspace` tag),
  `GET /api/vcs/branches`, `PATCH /api/project/{id}` (`v2.project.update`),
  9× `persistent-pty` (`server.experimental.persistentPty.*`).
- Semantic change: `POST /api/session/{id}/interrupt` now returns `200 {SessionInterruptResponse {interrupted: bool}}` not `204` — description updated to resume `steering + next-in-line control items (manual compaction, moves)` while queued prompts stay parked. Update `api.interrupt` to return that flag (store currently ignores the body).
- Cosmetic across all 99 retained paths: bodies inlined — `Union_*`/`Objects_*`/`Arrays_*` refs replaced by explicit `anyOf`/`items` (e.g. `Location.Ref` inline, `prompt` body with explicit `agents/files/skills` arrays). No `ONLY_SNAP` paths were removed; new schemas: `SessionStats.*`, `WorkspaceDestroyResult`, `SessionInterruptResponse`, `CommandExecutionErrorEncoded`, etc. Old generic `Union_*` removed.

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

## Extending checklist — when the diff grows

1. `bun run scripts/fetch-openapi.ts` → review `git diff docs/reference/openapi.json`.
2. Add missing client methods + types in `src/api/client.ts` / `src/api/types.ts` (one per endpoint, additive-only).
3. Decide UI: add a component/extension, or mark here as **client-only with reason** (don't leave a gap without a reason row).
4. Update this file if the feature is user-visible.
5. `bun run typecheck` must stay green. No new deps without justification (`AGENTS.md`, "Rules for editing").

## How to run the check

```
bun run scripts/fetch-openapi.ts      # refresh snapshot from live service
bun run scripts/diff-openapi.ts       # pretty drift summary
bun run scripts/diff-openapi.ts --json
bun run scripts/diff-openapi.ts --check   # exit 1 on drift (CI)
git diff docs/reference/openapi.json  # raw contract diff
```
