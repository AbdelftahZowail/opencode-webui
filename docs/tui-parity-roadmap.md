# TUI parity roadmap — everything opencode can do, in the browser

**Goal.** Reach feature parity with OpenCode v2 — its TUI, its engine and the
`/api/*` surface — not just with the routes we happen to have snapshotted.
When v2 can do something, the webui should be able to do it too.

**Placement rule (decided).** Anything **native to opencode itself** ships as
**core** here (`src/components/`, registered targets, store actions). The
extension system is for additive/non-native features. A native engine
capability must not live only in an extension.

**Companion map.** `docs/coverage.md` is the per-route have/don't-have map.
This file is the program. **How it gets built — waves, file ownership, frozen
interfaces, agent briefs — is `docs/parity-execution-plan.md`; read that before
starting any phase.**

---

## Which opencode we build on

One product line advancing — v2 — plus a v1 line that still publishes.

| Branch | What | Key packages | State |
| --- | --- | --- | --- |
| `dev` | **v1 line** (default branch) | `packages/opencode` (`opencode`), `@opencode-ai/cli`, `@opencode-ai/tui` | 1.18.31 |
| `v2` | **the rewrite — what we build on** | `@opencode/cli` **2.0.3**, `@opencode/tui`, `@opencode/client`, `@opencode/core`, `@opencode/schema` | HEAD 2026-09-15, tag `v2.0.0` |
| `2.0` | dead | — | April 2026 "2.0 exploration" — **ignore** |

| npm | Branch | Command | Version |
| --- | --- | --- | --- |
| `opencode-ai` | `dev` | `opencode` (historically) | 1.18.31 |
| `@opencode-ai/cli` | `dev` (transitional) | `opencode2` | `0.0.0-beta-N` |
| `@opencode/cli` | **`v2`** | `opencode` **and** `opencode2` | **2.0.3** |

`opencode` is now v2; `opencode2` is a retained alias (`@opencode/cli` declares
both bins). The engine this webui talks to reports **2.0.3**.

> **Provenance rule for this file.** Only two kinds of claim live here:
> things **measured** against the live engine / npm / git, and things **read
> from `v2` source**. Anything else is labelled unverified. This file was
> previously built from branch `dev` (the v1 line, because the local checkout
> was a shallow single-branch clone of `dev`) — that produced wrong phases
> (see "Dropped" below), so the rule is not bureaucratic.

## There is ONE surface, and it is `/api/*`

`@opencode/client` on branch `v2` declares **115 endpoints and every one is
`/api/*`** — zero legacy unprefixed paths:

```
$ grep -oE 'path: `[^`]+`' packages/client/src/promise/generated/client.ts \
  | sed 's/path: `//;s/`//' | sort -u
115 lines …  /api/* = 115,  non-/api = 0
```

The v2 TUI drives the engine **exclusively** through that client. So:

- **The legacy unprefixed surface is not our concern.** The 2.0.3 engine does
  still serve it (`/lsp` → 200 while `/api/lsp` → 404) — measured — but it
  exists for the **v1 TUI**, not v2's.
- **`server/index.ts` forwarding only `/api/*` is correct as-is.** No bridge is
  wanted, and the earlier "legacy allow-list bridge" plan is **dropped**.

### Dropped from an earlier draft (do not resurrect without evidence)

These were listed as gaps from the v1 TUI inventory. `v2` has **no endpoints**
for them at all, so they are not v2 features and not parity targets:

| Dropped | Why |
| --- | --- |
| Legacy allow-list proxy bridge | v2 client is 100% `/api/*`; nothing to bridge |
| Todos | `todo: 0` endpoints in the v2 client; the only `todo` in v2's TUI is a syntax-theme scope (`comment.todo`) |
| LSP / formatter status | `lsp: 0`, `formatter: 0` endpoints in the v2 client; v2's only `lsp` hits are a *tool* name and a permission action |
| Session share / unshare | `share: 0` endpoints in the v2 client |
| Console org switch | `dialog-console-org` exists on `dev`, not `v2` |
| Session pin + quick slots 1–9 | `session_pin_toggle` / `session.quick_switch.*` exist on `dev`'s keymap; absent from v2's command list |
| Which-key, tips, terminal chrome | `dev`-era TUI affordances |

Everything below is either v2-API-native or read directly from `v2` source.

---

## Status

| Phase | Scope | State |
| --- | --- | --- |
| P0 | Contract sync (snapshot + client + types + docs) | **done** (`31aefe3`) |
| P1 | ~~Legacy allow-list bridge~~ | **dropped** — v2 is `/api/*`-only |
| P2 | Turn-scoped diff viewer | **done** — `DiffViewer` (target `diff.viewer`), 3 sources, tree, hunk/file nav, split/unified, review markers |
| P3 | Worktrees + workspaces | **done** — `WorktreePanel` in the WorkspacePicker (+ `moveSessionToDirectory`) |
| P4 | Actionable settings: plugins, permissions, MCP, credentials | **done** for plugins / permission rules / MCP add-remove / credential relabel-delete. **Shell selection deferred** (no settings host; global preference) |
| P5 | ~~Legacy-only capabilities~~ | **dropped** (not v2 features) |
| P6 | Client-side conveniences (stash, timeline, frecency) | **partial** — prompt stash (panel + Ctrl+S + pop) and `@`-mention frecency are done; **timeline jump-to-message and directory recents are not built** |
| P7 | Webui correctness debts | **done** — interrupt truthfulness, `contextMenu.file` consumer, client aligned to `@opencode/client@2.0.3`; the scheduler fallback is kept and documented |

---

## P0 — Contract sync ✅ (uncommitted, awaiting review)

Snapshot 116 → **123** paths; contract layer synced additively; every new route
smoke-tested live. Details in `docs/coverage.md` ("What changed vs last snapshot
116 → 123"). Two upstream removals we never called: project-scoped
`/api/worktree/{projectID}` and `PATCH /api/session/{id}/message/{messageID}`.

## P2 — Turn-scoped diff viewer

**Validated:** `/api/session/{id}/diff` is in the v2 client, and v2 ships a
first-class diff viewer (`feature-plugins/system/diff-viewer*.tsx`,
`component/patch-diff.tsx`, with `diff.mark_reviewed`, `diff.next_file`,
`diff.next_hunk`, `diff.page.*`, file tree, split/unified). It has three
sources: working tree, default branch, and **last turn**.

We have the first two via `vcsDiff`; the turn source is the gap.

- Reuse `src/components/DiffView.tsx` (`parseDiff`/`DiffView`) — do **not**
  write a second diff renderer.
- Add a source switcher (working tree / branch base / last turn), file tree,
  per-file and per-hunk navigation.
- `sessionDiff` is already wrapped and verified live.
- Verify: a completed turn's diff matches `git diff` for the same range; a
  steered prompt folds into one turn.

## P3 — Worktrees + workspaces

**Validated:** `/api/worktree` and `/api/worktree/refresh` are in the v2 client;
v2 ships `dialog-workspaces.tsx`, `dialog-worktree-name.tsx`,
`dialog-workspace-file-changes.tsx`, and `dialog.worktree.generate` /
`dialog.move_session.*` commands. Location-scoped (the `{projectID}` routes were
removed upstream).

- Core UI: list / create / remove / refresh, unified with the existing
  `WorkspacePicker` + `moveSession` so "which directory is this session in" has
  one answer.
- `worktreeCreate` runs the project's setup script — show progress, don't block.
- Verify: create → run a session in it → remove; inventory reconciles after
  `worktreeRefresh`.

## P4 — Actionable settings

**Validated against v2:** `dialog.plugins.check` / `.update` / `.install` /
`.error` command ids; `/api/session/{id}/permission/rules`;
`/api/config/shell`; `/api/mcp` + `dialog.mcp.toggle`; `dialog-integration`
with `dialog.integration.delete` / `.rename`.

Build **actions, not readouts** — the Settings tabs for Plugins/WebSearch/Config/
Server were removed on purpose as informational.

- **Plugins:** list (`pluginList`, now full `source`/`features`/`state`), check
  (`pluginCheck`), update (`pluginUpdate`), package enable/disable. "Update
  available" is real and so is the button.
- **Permission rules:** `sessionPermissionRules` + `permissions` on session
  create — per-action allow/deny/ask, last match wins. Highest-value item here;
  v2's TUI only has a blunt toggle. Also consider wrapping
  `GET /api/permission/saved` (in the v2 client, not yet in ours).
- **Shell selection:** `configShells` + `configPreferences*` (global doc — **no
  `location` param**).
- **MCP write ops:** `mcpPut`, `mcpDelete`, `mcpResource`.
- **Credentials:** `providerGet`, `credentialPatch`, `credentialDelete`.
- **Not restoring:** a `configGet` dump, a `serverInfo` panel, a websearch
  panel, a `serviceStop` button.

## P6 — Client-side conveniences (trimmed to v2-verified)

Present in `v2` source: **prompt stash** (`dialog-stash.tsx`,
`prompt/stash.tsx`), **session timeline** (`routes/session/dialog-timeline.tsx`,
`message-navigation.ts`), **fork from timeline** (`dialog-fork.tsx`), **file
frecency** (`prompt/frecency.tsx`), **directory recents/completion**
(`prompt/directory-recents.ts`, `directory-completion.ts`), **notifications**
(`feature-plugins/system/notifications.ts`), **history** (`routes/session/history.ts`).

- We already have prompt history, drafts, export, themes, `@` mentions and a
  user-message rail.
- Port: stash (+pop/list), timeline jump-to-message, frecency ordering for `@`,
  directory recents.
- **Dropped:** pins, quick slots (not in v2).

## P7 — Webui correctness debts (measured on our own code)

- ✅ `store` ignored the `interrupt` response body (`{interrupted: bool}`). It
  now uses it: a failed abort surfaces a run notice instead of faking a stop,
  and `interrupted: false` (verified live against an idle session) no longer
  fabricates a `run.ended`. The flags are left to the LIVE-tier reconcile,
  which settles them within a tick, so nothing can stick.
- ✅ The `contextMenu.file` collection is documented in the spec and authoring
  guide but had **no core consumer** — third-party contributions were silently
  dropped. File rows in `FileExplorer` now render it (plus a built-in "Copy
  path"), and `ContextMenuContribution.run` learned the `file` context field.
- ℹ️ `src/lib/scheduler.ts` `if (!signals) return "live"` is **kept**: it is
  the right default for headless callers that start the scheduler without
  signals (the extension battery does). The "not wired yet" note was stale
  (`startStore` wires them) and has been corrected.
- ✅ Pinned `@opencode-ai/client@0.0.0-next-17444` was a **`dev`-scope
  prerelease** while we target the **`v2`** engine. Migrated to
  **`@opencode/client@2.0.3`** — what the engine line actually publishes
  (`npm dist-tags latest = 2.0.3`) — which ships the same `./service` surface
  (`discover` / `ensure` / `stop` / `headers`). Drop-in: proxy service
  discovery, the event recorder, all four batteries and the browser smoke
  checks were re-verified after the swap, and `diff-openapi --check` still
  reports zero drift.

---

## v2 TUI surface we have not yet assessed

Read from `v2` source but not yet turned into phases — these are candidate
gaps that need a UI decision, not a route (all endpoints are in the v2 client):

- **Session tabs** — `component/session-tabs.tsx`, `session-tabs-rail.tsx`,
  `session-frame.tsx`, `context/session-tabs.tsx`. We have split view (4 panes);
  v2 has a tab rail. Overlaps P2/P6 work.
- **Composer tabs** — `routes/session/composer/{shell,subagents,terminals}-tab`.
  We have `RunsPanel`; check parity of the terminal tab (`component/terminal-pane.tsx`).
- **`mini` mode** — `opencode mini`, a minimal interface (`src/mini/`).
- **Mermaid + LaTeX rendering** — `@opencode/merman`, `@opencode/latex` deps;
  `parsers-config.ts`. Do we render diagrams/math in messages?
- **Stats** — `feature-plugins/system/stats.tsx`, `stats-data.ts`
  (`/api/experimental/session/stats` in the v2 client, unwrapped by us).
- **Update notification** — `component/dialog-update.tsx`,
  `context/update-notification.tsx`, `retry-provider.tsx`.
- **Pairing / experiments / image preview** — `dialog-pair.tsx`,
  `dialog-experiments.tsx`, `dialog-image-preview.tsx`.
- **Session environment / context** — `/api/experimental/session/{id}/environment`,
  `/api/session/{id}/context` are in the v2 client and unwrapped by us.
- **Migration overlay** — `migration-overlay.tsx`.

## Endpoints in the v2 client that our client does not wrap

Mechanical diff (normalized; ~64 raw hits, several are matcher noise from
query-string interpolation — re-verify before acting). Genuinely notable:

`/api/agent/{id}`, `/api/permission/saved` + `/{id}`, `/api/session/{id}/context`,
`/api/session/{id}/permission`, `/api/session/{id}/form/{id}` (bare GET),
`/api/session/{id}/environment`, `/api/integration/{id}`,
`/api/experimental/session/stats`, `/api/experimental/session/{id}/export`,
`/api/experimental/session/{id}/instructions/entries`.

## What we have that v2's TUI doesn't

Keep this in view so parity work doesn't regress it: split view (4 panes), the
4-stratum extension system, global message-content search, `ActivityStrip`,
PWA/mobile, the SSE recorder + replay catch-up, forms-channel questions, and the
inbox steer/queue distinction.

## How to work this file

One phase per branch/PR. Every phase: typecheck green, live smoke-test each new
route, update `docs/coverage.md` (route → client → UI, or client-only **with a
reason**), and add a battery check if it touches the extension contract.
