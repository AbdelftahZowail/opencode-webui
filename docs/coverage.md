# API coverage — have / don't have / why

Source of truth for the HTTP contract: `docs/reference/openapi.json`
(snapshot of the running service's `/openapi.json`, 115 paths as of this doc).
Refresh: `bun run scripts/fetch-openapi.ts` (via `Service.ensure()` like the proxy).
Diff against live: `bun run scripts/diff-openapi.ts` (also `--json`, `--check` for CI).
Raw diff: `git diff docs/reference/openapi.json`.

`src/api/client.ts:368` holds one typed function per resource group; `src/api/types.ts:1`
holds the schema types. `server/index.ts:78` proxies any `/api/*` + websockets generically,
so new routes work without a proxy change. Keep the store as sole state (`src/store.ts:1`).

> Roadmap principle: "everything the engine can do must eventually be reachable from the UI"
> — but only user-facing resources get UI; internals stay client-only. This doc is that map.

## Have — wired in the webapp

| API group | OpenAPI paths | Client | UI |
| --- | --- | --- | --- |
| health/server | `GET /api/health`, `GET /api/server` | `api.health`, `api.serverInfo` | connection footer / Settings → Server |
| session lifecycle | `GET/POST /api/session`, `GET/DELETE /api/session/{id}`, `GET /api/session/active`, `POST import`, `GET export`, `POST fork`, `POST rename`, `POST move`, `POST compact`, `POST wait` | `listSessions`, `createSession`, `getSession`, `deleteSession`, `activeSessions`, `forkSession`, `renameSession`, `exportSession`, `compactSession`, `sessionWait` (via store) | Sidebar, session page, session actions (rename/fork/export/compact/move via inbox) |
| prompt/command/skill/synthetic/shell | `POST /api/session/{id}/prompt`, `POST command`, `POST skill`, `POST synthetic`, `POST shell`, `POST generate` (session-scoped), `GET context`, `GET/PUT/DELETE instructions/entries`, `GET message`, `GET message/{id}` | `prompt`, `promptWithFiles`, `runCommand`, `activateSkill`, `sessionShell`, `sessionGenerate`, `messages`, `inbox*` | Composer, slash menu, `@` file refs, `!` bash, skill picker, shell panel |
| events (SSE) | `GET /api/event` | `src/api/events.ts` | `store.handleEvent` live streaming (queued→running→ordered parts, poll fallback) |
| permissions/forms/questions | `GET /api/permission/request`, `GET /api/permission/saved`, `GET/POST /api/session/{id}/permission*`, `GET /api/form/request`, `GET/POST /api/session/{id}/form*`, legacy `question` routes | `pendingPermissions`, `replyPermission`, `pendingForms`, `sessionForms` (per-session backfill), `formState/replyForm/cancelForm`, `question*` | `PendingRequestsPanel` (composer-slot FIFO panel per focused session + corner chip for others), queue in store. Ground truth (2026-08-26, `scripts/uitest/probe-*.ts`): GLOBAL form listing can omit a pending question-form indefinitely under load — mounted sessions are polled per-session and unioned by id; `/form/{id}/state` is authoritative but 404s transiently right after creation (60s newborn grace before trusting it); question multiplicity = field type (`multiselect` ⇒ array answers, `string` ⇒ one string); no native question REST routes on this engine (events only). Permission listing semantics unverified live (deployment auto-allows) — refresh unions by id, removal event-driven |
| inbox/steering | `GET /api/session/{id}/inbox`, `DELETE inbox/{id}`, `POST steer/queue` | `inboxList/Queue/Steer/Delete`, `inboxPrompt`, `prompt/promptWithFiles` (optional `delivery`) | Explicit STEER vs QUEUE system: busy sends become tracked inbox rows in `QueueStrip` (toggle/send-now/cancel), reconciled by `session.inbox.*` events + poll; queue-drain failsafe on turn end. `InboxPanel` unchanged |
| revert | `POST revert/stage`, `POST revert/clear`, `POST revert/commit` | `revertStage/Clear/Commit` | `/undo` `/redo`, `applyRevertView` cut of transcript |
| agent/model/command/skill catalog | `GET /api/agent`, `GET /api/agent/{id}`, `GET /api/model`, `GET /api/model/default`, `GET /api/command`, `GET /api/skill` | `agents`, `models`, `commands`, `skills` | Pickers (`Pickers.tsx`), command palette, skill picker, variants |
| provider/integration/credential | `GET /api/provider`, `GET /api/provider/{id}`, `GET /api/integration`, `POST connect/key|oauth|command`, `PATCH/DELETE /api/credential/{id}` | `providerList/Get`, `integration*`, `credentialPatch/Delete` | Settings → Providers/Integrations/Credentials |
| mcp/plugin | `GET/PUT/DELETE /api/mcp*`, `POST connect/disconnect`, `GET resource`, `GET /api/plugin` | `mcpList/Put/Delete/Connect/Disconnect/Resource`, `pluginList` | Settings → MCP / Plugins |
| filesystem/location/project | `GET /api/fs/read/*`, `GET /api/fs/list`, `GET /api/fs/find`, `GET /api/location`, `GET /api/project`, `GET /api/project/current` | `fsRead/ReadBytes/List/Find`, `location`, `project*` | FileExplorer, workspace picker, path chips |
| vcs | `GET /api/vcs`, `GET /api/vcs/status`, `GET /api/vcs/diff`, `GET /api/vcs/branches` | `vcsStatus/Diff`, `vcsQuery` helper | FileExplorer diff, VCS status badge |
| pty/shell | `GET/POST /api/pty`, `GET/PUT/DELETE /api/pty/{id}`, `POST connect-token`, `GET connect`, `GET/POST /api/shell*` | `pty*`, `shell*` | Shell panel, `TerminalView.tsx` (xterm) via websocket proxy |
| websearch/config | `GET /api/websearch/provider`, `POST /api/websearch`, `GET /api/config` | `websearch*`, `configGet` | Settings → WebSearch / Config |
| worktree | `GET/POST/DELETE /api/worktree/{projectID}`, `POST refresh` | (proxied, not yet wrapped) | surfaced via workspace selection |
| interrupt/background | `POST /api/session/{id}/interrupt?continue`, `POST background` | `interrupt`, `flushSteersNow` (`continue=true`: interrupt + resume steering, queue stays parked), `sessionBackground` | Esc two-step interrupt, QueueStrip "interrupt & send now", Ctrl+B background subagents |

## Client-only — valid routes, no dedicated UI (by decision)

| API group | Paths | Client | Reason |
| --- | --- | --- | --- |
| `POST /api/generate` | `v2.generate.text` | `api.generate` | Stateless one-shot generation without session/tools — chat (`session/prompt`) supersedes it. Called from plugin/tool contexts (`ctx.generate.text`) where needed. |
| `GET /api/reference` | `v2.reference.list` | `api.referenceList` | Engine reference bookkeeping (local/git references) — opaque internals, no user action. |
| `GET /api/debug/location`, `DELETE /api/debug/location` | `v2.debug.location.*` | proxied only | Debug — evict loaded location. |
| `GET /api/experimental/session/{id}/log` | `v2.session.log` | `api.sessionLogHead` | Engine's DURABLE per-session event log with an aggregate-seq cursor. Spike-verified (2026-08-31, `scripts/uitest/spike-v2-log.ts`): durable across process lifetimes (an 8-day-old session serves its head seq), `follow=false` returns a `log.synced` head marker for ANY `after`, but `follow=true` streams ZERO bytes on beta-18684 — no replay, no tail. Wired as dormant cursor tracking (`store.logHeadSeq`, probed on adopt/reconnect); the proxy recorder remains the catch-up channel until a build ships a working follow. |
| `GET /api/experimental/migration/v1` | `v2.experimental.migration.v1.status` | proxied only | V1 migration status. |
| `POST /api/experimental/integration/wellknown` | `v2.experimental.integration.wellknown.add` | integration well-known | Experimental integration discovery. |
| `POST /api/session/{id}/view` | `v2.session.view {idle}` | (add on next client pass) | Marks viewer's idle transition as viewed — spike-verified accepted (204) but with no observable effect on this build, and the §4.4 active-map lag it would address did NOT reproduce (session left `/session/active` within one poll of `wait` resolving). Wire if we add viewed/idle badges or the lag returns. |
| `GET /api/session/stats` | `v2.session.stats ?from&to&project&timezone&tools` | (add on next client pass) | Aggregate activity/usage/tool reliability — dashboard/telemetry surface, deliberate follow-up (see Extending checklist). |
| `POST /api/workspace`, `DELETE /api/workspace/{id}` | `v2.workspace.create/destroy` | (add on next client pass) | Logical workspace lifecycle (idempotent create/destroy `{id?, provider}`) — we use `project` today; track for future workspace UI. |

## Experimental / infra — not surfaced in webapp

| API group | Paths | Notes |
| --- | --- | --- |
| persistent-pty | `GET/POST /api/experimental/persistent-pty/*`, `GET/POST /api/experimental/session/{id}/terminal` | Prototype persistent PTY (`server.experimental.persistentPty.*`) — keep `src/api/client.ts:642` location-scoped `pty` as canonical; revisit if promoted from experimental. |

## What changed vs last snapshot (99 → 115 paths)

Snapshot `docs/reference/openapi.json` at `2026-08-16` was 99 paths (`@opencode-ai/client@0.0.0-next-17444`).
Refreshed to 111 (`2026-08-26`), then to 115 (live as of 2026-08-31):

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

Webapp stays on Promise: `server/index.ts:13` `Service.ensure()` + `src/api/client.ts:113` `request<T>`.
The `/effect` entrypoints are additive — same OpenAPI at `/openapi.json`. Building a server plugin
or embedding via SDK would pick one style; webapp contributors ignore it. Doc ref:
`opencode.ai/v2/docs/build` (Build overview) · `/build/plugins` + `/build/plugins/cli` ·
`/build/client` (`@opencode-ai/client@beta`) · `/build/sdk` (`@opencode-ai/sdk@dev`).

## Extending checklist — when the diff grows

1. `bun run scripts/fetch-openapi.ts` → review `git diff docs/reference/openapi.json`.
2. Add missing client methods + types in `src/api/client.ts` / `src/api/types.ts` (one per endpoint, additive-only).
3. Decide UI: add a component/extension, or mark here as **client-only with reason** (don't leave a gap without a reason row).
4. Update this file + `AGENTS.md:155` roadmap table + `HANDOFF.md` if the feature is user-visible.
5. `bun run typecheck` must stay green. No new deps without justification (`AGENTS.md:117`).

## How to run the check

```
bun run scripts/fetch-openapi.ts      # refresh snapshot from live service
bun run scripts/diff-openapi.ts       # pretty drift summary
bun run scripts/diff-openapi.ts --json
bun run scripts/diff-openapi.ts --check   # exit 1 on drift (CI)
git diff docs/reference/openapi.json  # raw contract diff
```
