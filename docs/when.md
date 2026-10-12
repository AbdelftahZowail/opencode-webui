# When — conditional TODOs (trigger → task)

Things we deliberately did **not** build or wire, with the condition that makes
them worth doing. This is the "todos when xxx happens" bucket: each row is a
watch, not a backlog item. When the trigger fires, do the task; until then, doing
it early is speculative work.

| When… | Do | Why / where |
| --- | --- | --- |
| The engine ships a **working session-log `follow`** (a build after beta-18684) | Replace the proxy event recorder's catch-up channel with the durable per-session log; retire `fetchReplay`. | `reference/coverage.md` `/api/experimental/session/{id}/log`. Tracked by `bun run check:swap` (AGENTS.md). |
| We add **viewed/idle badges**, **or** the active-map lag it addresses returns | Wrap `POST /api/session/{id}/view` (`{idle}`). | Accepted (204) but no observable effect on this build; spike-verified. `reference/coverage.md`. |
| The engine **documents callable RPC methods** | Revisit `POST /api/rpc/{rpcID}/{method}` and expose something real to user actions. | Currently a proxied-only generic escape hatch with no UI. |
| Persistent-PTY / terminal is **promoted out of experimental** | Revisit `experimental/persistent-pty/*`; keep the location-scoped `pty` group canonical meanwhile. | `reference/coverage.md` experimental table. |
| ~~A **highlighter dependency is approved** (§9.1)~~ **Fired — R1/R2 landed 2026-10-12** | (done) shiki syntax highlighting + mermaid/katex. | `plans/parity.md` R1/R2. |
| ~~The **built-in markdown surfaces exist** (R1/R2 shipped — 2026-10-12)~~ **Fired — R14 code-block renderers landed 2026-10-12** | (done) `markdown.registerCodeBlockRenderer` / the `markdown.codeBlock` collection, dogfooded by mermaid/latex; the rest of the R14 API (`ui.panel`/tabs/dialogs/attention/keymap) stays demand-gated. | `plans/parity.md` R14. |
| **v1→v2 migration is in play** for a user | Build the migration overlay (R11); wire v1 migration status. | `plans/parity.md` R11; `/api/experimental/migration/v1`. |
| ~~A **"Terminal" settings host** exists~~ **Fired — R12 landed 2026-10-12** | (done) shell selection lives in Settings › Shell (`settings.shell`). | `plans/parity.md` R12, `reference/coverage.md`. |
| ~~The webui ships a **self-update surface**~~ **Fired — R11b landed 2026-10-12** | (done) proxy `GET /api/webui/update/check` + `POST /api/webui/update`; `UpdateNotice` install/restart wired. Install applies on the **published** channel; dev checkout / compiled binary log + no-op (documented limitation). | `plans/parity.md` R11. |
| ~~A **server-side session search / cross-project picker** is needed~~ **Fired — R11a landed 2026-10-12** | (done) `sessionList.dialog` + `open.picker` mounted; store session-search state; `api.listSessions` search ("this project" is a client-side directory filter — the engine search is global). | `plans/parity.md` R11. |
| ~~A user asks for the **permission-prompt-fullscreen** toggle~~ **Fired — R12 landed 2026-10-12** | (done) `permissionFullscreen` pref wired into `PendingRequestsPanel` (Settings › Security default; `ctrl/⌘+f` toggles the active request). | `plans/parity.md` R12. |
| A real extension needs the **inspector / secrets / theme-service / replay-log / hook-priority / i18n** | Build that item from the as-demand bucket. | `plans/extensions.md` §As-demand (item 10). |
| An **SCM- or editor-style extension** is wanted | E6 (proxy fs-watch + bounded spawn + typed engine client) before the extension. | `plans/extensions.md` E6 — the probe was a source-control panel. |
| The **agent (or authors) are writing extensions at volume** | E2 (runtime catalog: props/owners/descriptions) — so authors don't read core source. | `plans/extensions.md` E2. |
| The extension surface **changes again** | That is the signal E7 is overdue; snapshot the vocabulary + add the drift check. | `plans/extensions.md` E7. |
| `mcpResource` **needs a surface** | Add it to an expanded MCP server row. | Client-only today; `reference/coverage.md`. |
| `providerGet` **needs a detail view** | Open a single provider's detail from `ConnectDialog`. | Client-only today. |
| **Single shell fetch** is needed | Wire `api.shellGet` (`GET /api/shell/{id}`). | Genuine gap (minor); `reference/coverage.md`. |
| Session **environment/context** proves useful | Surface `/api/experimental/session/{id}/environment` and `/api/session/{id}/context`. | Candidate gaps; unwrapped, `plans/parity.md` §4. |
| A **gate looks vacuous** | Reintroduce the bug, watch the check go red, restore it. | `.opencode/release-helper.md` — any ms-window assertion needs both-ways proof. |
| Running a **prod-shaped smoke test** | Pin the engine via `WEBUI_ENGINE_URL`/`WEBUI_ENGINE_PASSWORD` from the live `service.json`; don't rely on the registration fallback. | `.opencode/release-helper.md`. |
| A **contract change** lands | Version bump + regen the skill + tag before publish (never publish without the tag). | `runbooks/add-extension.md`, `.opencode/release-helper.md`. |
