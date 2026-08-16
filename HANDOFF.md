# HANDOFF — opencode-webui

> Read this FIRST in a new session. It replaces the need for the full build
> history. AGENTS.md holds the architecture rules; this file holds the state
> and what's left. Read both, plus `ui-extensions/README.md`.

## What this project is

A web frontend for the **OpenCode v2 engine** (the `opencode2` background
service). The browser never talks to the service directly — a **Bun proxy**
(`server/index.ts`) discovers the service (`Service.ensure`), attaches auth,
forwards `/api/*`, serves `dist/` in production, and (new) proxies
**websockets** for PTY terminals.

Stack: React 19 + Tailwind v4 + Vite 8 + Bun. Dark-only. Sessions are v2
session-centric (NOT v1 project-centric).

**Design DNA (OC-2 tokens)**: `src/styles.css` holds the full token system
extracted from opencode's own `packages/ui` (MIT): `--background-base: #101010`,
`--surface-float-base`, `--text-strong/weak`, `--border-selected: #9dbefe`,
`--surface-brand-base: #fab283`, status/diff palettes, Inter + JetBrains Mono.
**Rule: components consume tokens as `var(--...)`, never hardcode hex.**

**UI primitives**: shadcn/ui vendored into `src/components/ui/` (button,
dialog, dropdown-menu, command [cmdk-REPLACED by internal impl — see Known
issues], scroll-area, tabs, input, textarea, select, sheet, badge, switch,
separator, skeleton, popover, tooltip, message-scroller, marker).

**Extension system**: `ui-extensions/` folders + `src/extensions/registry.tsx`
slots (`sidebar`, `footer`, `composer.replace`, `tool.renderer`) + enable-list
(`ui-extensions/config.ts`). Extensions build on the same primitives/tokens.
Do not break the slot contract.

## How to run

```
cd ~/opencode-webui
bun run dev          # UI http://localhost:5173 · proxy :4097 (auto-starts the opencode service)
bun run preview      # second dev instance for WIP: http://localhost:5174 · proxy :4098
bun run typecheck    # tsc --noEmit (must stay green)
bun run build && bun start   # production on :4097
```

**Clean start with logging (recommended)** — `scripts/start-dev.sh` starts the
stack detached with `WEBUI_DEBUG=1`:
```
scripts/start-dev.sh
# frontend logs -> /tmp/webui-debug.log · server/proxy logs -> /tmp/webui-server.log
tail -f /tmp/webui-debug.log
```

**Stopping**: kill the process tree by PID — `ps aux | grep -E "bun run|vite"`,
then `kill -9 <pids>`. **Never `pkill -f`** on these patterns: the pattern
matches the shell running the command and kills it too (gotcha #4 below).

## State: DONE (verified unless noted)

- Extension system + preview instance (`bun run preview`)
- Wave 1 restyle: all screens on OC-2 tokens + shadcn (sidebar, conversation,
  composer w/ Command-palette slash menu, transcript, tool cards, modals)
- Wave 2 TUI parity: `@` file refs, `!` bash, session actions
  (rename/fork/export/compact), thinking + tool-details toggles (`src/prefs.ts`),
  7 themes (`src/theme/themes.ts`, from v2 TUI palettes), command palette
  (ctrl+p) + hotkeys (ctrl+n), DiffView component
- Phase 2 API coverage: workspace picker, file explorer (+vcs badge + diff),
  shell panel, PTY management, settings hub (providers/integrations/MCP/
  plugins/websearch/config/server), question modal, inbox steering
- **Live terminal emulator**: `TerminalView.tsx` (xterm.js) + websocket proxy
  in `server/index.ts`. **Verified end-to-end via script** (bash through the
  proxy, echo/pwd worked). **NOT verified visually in a browser** — see below.
- **Message scrolling fixed**: replaced hand-rolled `scrollIntoView` with
  vendored MessageScroller (`defaultScrollPosition="end"` + `autoScroll` +
  `flex-1` on the Root — the `size-full` bake was the clipping bug).
  **Applied, awaiting user's visual confirmation** — see below.
- **Live streaming nailed down & verified** (2026-08-16):
  - Verified transport: `/api/event` streams deltas through BOTH hops
    (proxy 4097 and Vite 5173) — captured `session.text.delta`,
    `session.reasoning.delta`, `session.tool.input.delta` with the exact
    field names the store expects (`sessionID`, `assistantMessageID`, `delta`).
  - **Fixed "second message doesn't appear"**: `loadMessages` used to reset
    `live: []` for the current session; a settle fetch racing the persistence
    write could clear a just-finished answer before it landed (and a late
    fetch could wipe the NEXT run's in-flight stream). Now `loadMessages`
    keeps live assistants whose persisted copy isn't in the fetched history,
    and execution end runs `settleLiveMessages` (drop placeholder → reload →
    retry once after 1.5s if still missing). Verified by replaying a real
    two-prompt event capture through the store: both runs stream live into a
    live assistant and settle cleanly into history.
  - **Fixed "thinking…" duplicate**: `session.execution.started` has no
    assistantMessageID, so the store created a "pending" placeholder that was
    never re-keyed; `session.step.started` now adopts it into the real
    assistant id (`adoptPendingAssistant`).
- **Default-model mismatch fixed & verified** (2026-08-16): sessions created
  with `model:null` were silently resolved by the SERVICE at run time (to
  glm-5.3, rate-limited) while the picker displayed the primary agent's model
  (deepseek-v4-flash-free). `newSession()` and all `send*` actions now PIN the
  session to the UI default (`api.switchModel`) when the session has no model;
  the pickers now read the authoritative `GET /api/session/{id}` via a new
  `sessionDetails` store slice. Verified end-to-end via
  `scripts/uitest/check-default-pin.mjs` (session resolves to the pinned model
  in list view, detail, and on the service).
- **ToolCard live-render crash fixed** (2026-08-16): `LiveAssistantView` built
  live tool parts without a `state`/`time` field, so `ToolCard` crashed on
  `part.state.status` the moment an assistant streamed a tool call — React
  unmounted the whole tree, which read as "it stopped streaming / refreshed".
  Now a shared `liveToolPart()` builds the exact `ToolPart`/`ToolState` shape,
  and `ToolCard` no-ops on a missing `state`. Verified by replaying a
  tool-heavy run through the store with part construction
  (`streaming` → `completed`).
- **SSE silent-stall root cause found + fixed** (2026-08-16): instrumented the
  browser event pipeline and observed `[events] no data for 30s; forcing
  reconnect` — the `/api/event` channel can go completely silent (no bytes,
  no close) while the connection still "looks" connected. During a silent
  stall no live events render and nothing appears until a page reload. Two
  complementary fixes:
  1. **Watchdog** in `connectEvents`: if no bytes arrive for 30s, cancel the
     reader and force a reconnect (the service replays recent events on
     connect). Verified firing + recovery live in the browser.
  2. **Live-poll fallback** in the store: while a session is `running` (or has
     live content), poll its messages every 2s and reconcile the transcript
     (merge persisted messages, prune settled live assistants and optimistic
     local user messages once the real copy exists). A finished answer can
     never be lost behind a dead stream again.
- **Error boundary + store HMR recovery** (2026-08-16): `ErrorBoundary.tsx`
  wraps the app so a render error never blanks the page again (shows the
  message + Retry). NOTE: the first `import.meta.hot.accept` attempt on
  `store.ts` was REMOVED — it re-created the module (fresh state + fresh
  listeners) while components stayed subscribed to the dead instance,
  freezing the UI. Default Vite full-reload on store.ts edits is correct.
  Other src module edits cause normal Vite HMR/full-reloads — expected in
  dev, not in production.
- **Verified in the real browser** (2026-08-16, via `scripts/uitest` + Chrome
  automation): open an old session → full history loads; send → optimistic
  user message, then live "Agent is working…" + streaming Reasoning + text;
  on completion the transcript settles cleanly (no duplicates, full
  markdown); multiple sequential runs work; model picker shows the pinned
  default. The earlier "history won't load / EmptyHint" state was stale
  dev-server state — cleared by restarting the dev server.
- **"Only adds the message, doesn't listen" — root cause found** (2026-08-16):
  when you send to a session whose engine run is active, the message is
  QUEUED (`session.inbox.enqueued`) and can wait minutes behind the active
  run. In this deployment the service emits NO `session.execution.*` events
  for the queued handoff (it joins the active run), so the UI had no signal:
  no "working" badge, no live fallback, nothing until the queued run finally
  streamed. Fixes:
  1. **`queued` state** (`store.queued`): set on `session.inbox.enqueued` for
     the current session; a "waiting" header badge + "Waiting for the
     agent…" composer placeholder make the wait visible. Also set
     OPTIMISTICALLY on every send so the provider cold-start gap (~15s of
     silence before the first event) is covered too.
  2. **Running fallback**: if `session.execution.started` never appears, a
     `step.started` for a queued session promotes it to `running` (working
     badge / Stop engage), and the final `step.ended` with `finish:"stop"`
     clears it (tracked via `seenExecution` so the real execution events win
     where they exist).
  3. The **always-poll** safety net (see below) finalizes the transcript even
     in the no-execution-events path.
- **Messy multi-step live rendering fixed** (2026-08-16): the engine emits one
  assistant message per step (reasoning / tool / text), so during a run the
  transcript stacked partial bubbles and, once persisted, repeated the
  "build <agent> <provider>/<model>@<variant>" header on every step. Fixes:
  1. **Merged live block**: `Conversation` merges ALL live assistants for the
     session into one growing block (reasoning + tools + text) so streaming
     reads like a single assistant message.
  2. **Compact continuation messages**: consecutive assistant messages render
     without the repeated agent/model header (first one keeps it).
  3. **Empty text parts** (e.g. the "\n\n" stub step) are skipped.
  Verified in the browser: a 2-step tool run renders user → assistant
  (header + reasoning + tool card) → assistant (content only).
- **Frontend + proxy debug logging** (2026-08-16): `src/lib/log.ts` batches
  collapsed log lines (`[boot] [sse] [evt] [gate] [run] [session] [send]
  [model] [load] [poll]`) and POSTs them to a new proxy sink `POST /api/debug`
  which appends to `$WEBUI_DEBUG_LOG` (default `/tmp/webui-debug.log`). The
  proxy logs every `/api/*` request + SSE health to stdout when
  `WEBUI_DEBUG=1`. Console mirror: `localStorage.setItem("webui.debug","1")`
  then reload. See the "Debugging the streaming path" note below.
- **UI test scripts** added under `scripts/uitest/` — see the section below.

## WHAT'S LEFT (the agenda)

### 1. VERIFY the two unverified fixes — ✅ DONE (2026-08-16)
- [x] Scroll behavior: **found + fixed a real bug** — Conversation root div was
      `flex min-w-0 flex-1 flex-col` WITHOUT `min-h-0`, so the MessageScroller
      grew to content height and never scrolled (clipped everything below the
      fold on long sessions; short sessions masked it). Added `min-h-0`.
      Verified in browser: long session lands at bottom, scroll up freely, no
      yank while streaming, scroll-to-end button appears/hides correctly.
- [x] Terminal emulator: **found + fixed TWO real bugs** —
      1. `vite.config.ts` `/api` proxy lacked `ws: true` → browser WS upgrade
         to `ws://localhost:5173/api/pty/...` was dropped ("WebSocket is closed
         before the connection is established"). Added `ws: true`.
      2. `src/api/client.ts` `ptyUpdate` (PUT, resize on fit) sent a JSON body
         without `content-type: application/json` → service returned 415.
         Added the header (confirmed 415→200 via curl against :4097).
      Verified in browser: prompt renders, `echo` round-trips, Ctrl+C works.

### 2. USER FEEDBACK — POLISHING PASS
**The user will supply a list of polish items. Turn each into a task; keep
tokens/slots/dependency rules; verify with typecheck + build + browser.**
Feedback placeholder — paste below in the new session:
```
- (user feedback items go here)
```
**Last round (2026-08-16) — status:**
- [x] Sidebar: workspace grouping with ~7 per group + "Show N more…" + "Load
      more sessions" pagination (was already implemented; kept). Added hover
      titles + hardened truncation so long session names never overflow the
      right edge.
- [x] "New session" creates AND focuses the new session (was already wired;
      also pins default model now).
- [x] Model selector reflects the real default agent/model (see DONE notes).
- [x] Live streaming nailed (see DONE notes) — verified by
      `scripts/uitest/two-prompt.sh` + `replay-store.mjs`.
- [x] Queued/waiting feedback for messages sent while a run is active or
      during provider cold start (see DONE notes).
- [x] Multi-step live rendering: merged live block + compact continuation
      headers + empty-part skipping (see DONE notes). Verified in browser.
- [x] Full frontend+proxy debug logging (`/tmp/webui-debug.log`), clean
      start script (`scripts/start-dev.sh`), kill-by-PID guidance.
- [ ] Pending visual confirmations from the user: sidebar overflow, model
      selector default, second-message streaming, scroll behavior, and the
      multi-step rendering above.

### 3. GIT — first commit (repo has ZERO commits, everything untracked)
- [x] Repository initialized with a sensible `.gitignore` and the whole working
      tree committed in `4482fad` (`Initial OpenCode web UI`).
- [x] `bun.lock` is included; generated `dist/` and `.vite` cache remain ignored.

### 4. PRODUCTION SMOKE TEST
- [x] `bun run build` + production server smoke-tested on isolated proxy `:4099`:
      `/` and an unknown SPA route served `dist/`, and `/api/webui/status`
      reached the service successfully. The live dev instance on `:4097` was
      left untouched. Full sessions/chat/settings plus a production PTY flow
      remain a manual browser check if needed.

### 5. LONG-TAIL ROUTES (client fns EXIST in `src/api/client.ts`, no UI):
`generate`, `reference`, `serverInfo/serviceStop` (stop is in settings already),
`experimental/*`, `debug`. Decide with the user if any deserve UI (low value;
likely skip or fold into settings).

### 6. EXTENSION AUTHORING TEST on the new UI
- [x] Added `ui-extensions/runtime-status/` through the documented flow:
      registered a footer slot, wired `ui-extensions/index.ts`, enabled the id
      in `config.ts`, and verified the native token-based status footer in the
      browser at desktop and `390px` widths.

### 7. RETEST `bun run preview` (5174/4098) — second-instance isolation.
- [x] Started the isolated preview and verified `5174/` plus `/api/webui/status`
      through proxy `:4098`; stopped only the temporary preview process tree.

### 8. HOUSEKEEPING
- [x] Confirmed leftover test session `ses_ff9ee78e` is already absent from the
      service session list; DELETE returned the expected `SessionNotFoundError`.
- [ ] Reference material lives in /tmp (see below) — copy what's worth keeping
      into the repo or leave as-is; nothing is critical to ship.
- [ ] AGENTS.md roadmap table is current (✅ all done except nothing pending).

## Known issues & gotchas (read before touching things)

1. **Vite stale-transform bug (recurring)**: after rapid multi-file edits,
   Vite can serve modules missing imports ("X is not defined" while the file
   on disk is correct). Fix: restart dev (`bun run dev`); hard-refresh
   browser (Ctrl+Shift+R). Not a code bug.
2. **cmdk was REMOVED** (crashed with React 19: "Cannot read properties of
   undefined (reading 'subscribe')"). `src/components/ui/command.tsx` is now a
   self-contained implementation (same exports: Command/CommandDialog/
   CommandInput/CommandList/CommandEmpty/CommandGroup/CommandItem/
   CommandSeparator/CommandShortcut). Preserve it; don't reintroduce cmdk.
3. **Theme override specificity**: `applyTheme` in `src/theme/themes.ts`
   injects `:root:root { … }` (double pseudo-class) because plain `:root`
   loses to Vite's CSS injection order. Keep the `:root:root`.
4. **pkill self-match**: `pkill -f "pattern"` matches the shell running it if
   the pattern is in the command line (killed our own shell twice). Use a
   script file for kill/restart (`scripts/start-dev.sh`), or kill by exact
   PID: `ps aux | grep -E "bun run|vite"`, then `kill -9 <pids>`. Never
   `pkill -f "bun"` / `pkill -f "vite"`.
5. **PTY connect-token** needs header `x-opencode-ticket: 1` AND an allowed
   Origin (localhost:any is allowed by the service). The proxy now forwards
   all client headers (previously only content-type — that was a bug, fixed).
6. **PTY connect is a websocket**; protocol: outbound = raw UTF-8 + one binary
   control frame (`0x00` + JSON `{cursor}`) — skip binary frames when writing
   to xterm. The connect endpoint requires `?ticket=` from connect-token.
7. **Store/API rule**: additive-only changes (new exports, never modify
   signatures) — several components depend on stable contracts.
8. **Approved runtime deps** (documented in AGENTS.md rule 5):
   `@shadcn/react` (MessageScroller) and `@xterm/xterm` + `@xterm/addon-fit`.
   Anything else needs justification.
9. Browser automation tool was unreliable late in the build (pages kept
   closing) — verify UI changes visually with the user, don't trust headless
   checks alone.

## File map (key files)

```
server/index.ts                    proxy: /api passthrough + websockets + dist
src/styles.css                     OC-2 tokens + shadcn var mapping (the contract)
src/extensions/registry.tsx        slots (sidebar/footer/composer.replace/tool.renderer)
ui-extensions/                     extension folders + index.ts + config.ts + README
src/store.ts                       central state + event reducer (+ questions queue, sessionDetails)
src/api/client.ts                  typed REST client (all route groups)
src/api/events.ts                  SSE parser
src/components/ui/                 shadcn primitives + command + message-scroller
src/components/Conversation.tsx    header + MessageScroller transcript
src/components/Composer.tsx        slash menu + @ refs + ! bash
src/components/ToolCard.tsx        tool cards (extension hook: getToolRenderer)
src/components/Sidebar.tsx         session rail grouped by workspace + Files/Shell/Settings/Inbox
src/components/Pickers.tsx         agent/model pickers (authoritative session detail)
src/components/ShellPanel.tsx      shell mgmt + terminals (TerminalView)
src/components/TerminalView.tsx    xterm terminal emulator
src/components/FileExplorer.tsx    fs tree + preview + diff (DiffView)
src/components/settings/           settings hub sections
src/components/QuestionModal.tsx   mid-task questions
src/components/InboxPanel.tsx      inbox queue/steer
src/theme/themes.ts                7 themes (applyTheme :root:root injection)
src/prefs.ts                       showReasoning/showToolDetails prefs
src/hooks/useHotkeys.ts            ctrl+p / ctrl+n / escape
scripts/uitest/                    reusable UI/test helper scripts (see section below)
AGENTS.md                          architecture rules + roadmap (keep updated)
ui-extensions/README.md            extension authoring guide (keep updated)
```

## UI test scripts (`scripts/uitest/`)

Reusable helpers for exercising the app + service through the proxy without
hand-writing one-off curl/js each time:

| Script | What it does |
| --- | --- |
| `create-session.sh [provider/id]` | create a session, prints its id |
| `send-prompt.sh <sid> <text>` | fire-and-forget prompt (like the UI) |
| `wait-done.sh <sid> [secs]` | block until the session stops running |
| `messages.sh <sid> [limit]` | pretty-print persisted history |
| `capture-events.sh [out]` / `stop-capture.sh [out]` | background-capture `/api/event` to a file (+ pid) |
| `replay-store.mjs <events> <sid>` | replay a capture through the real store reducer → prints live state exactly as the transcript renders it (THE streaming proof) |
| `check-default-pin.mjs` | run `newSession()` headlessly → asserts the session model is pinned to the UI default |
| `smoke.sh [prompt] [model]` | create → capture → prompt → wait → print history + store replay |
| `two-prompt.sh [model]` | regression for the "second message disappears" bug |
| `start-dev.sh` (repo root, `scripts/`) | clean start with debug logging (see "How to run") |

`env.sh` defines `$BASE` (proxy, default 4097) and `$EVT_OUT`. Example:
`BASE=http://127.0.0.1:4098 scripts/uitest/two-prompt.sh` for the preview proxy.

## Debugging the streaming path

The frontend logs everything to `/tmp/webui-debug.log` (via the `/api/debug`
proxy sink) and the proxy logs requests to stdout when `WEBUI_DEBUG=1`.

```
# terminal 1 — dev server, capturing server-side logs
WEBUI_DEBUG=1 bun run dev > /tmp/webui-server.log 2>&1 &

# terminal 2 — watch the frontend log (this is the one to check first)
tail -f /tmp/webui-debug.log
```

Overriding the log path: `WEBUI_DEBUG_LOG=/path/to.log WEBUI_DEBUG=1 bun run dev`.

Reading the log — the line you care about when a message "doesn't stream":
`[send]` (message sent) → `[evt] session.inbox.enqueued` / `[run] queued`
(queued behind the active run) → `[evt] session.step.started` + `[run] live
via step.started` (it finally started) → `[evt] session.reasoning.delta /
text.delta` (live streaming) → `[poll] reconcile … N -> M messages` (safety
net picked it up). If you see `[gate] … skipped`, the events are for a
session the UI doesn't have selected. `[sse] STALLED` / `reconnect` = the
stream hiccupped and auto-recovered. Console mirror of the same lines:
`localStorage.setItem("webui.debug","1")` in the app then reload.

## Reference material (in /tmp, from the build)

- `/tmp/opencode-src` — clone of anomalyco/opencode: **v2 TUI source**
  (`packages/tui`, React) = the behavioral spec; `v1.18.9` tag has the web UI
  (`packages/app`) + design system (`packages/ui/src/styles/*.css`).
- `/tmp/oc-theme.css`, `/tmp/oc-colors.css` — extracted token files.
- `/tmp/oa.json` — the live v2 OpenAPI spec (authoritative for field names).
- `/tmp/opencode-wave{1,2,3}/` — per-package specs used for the parallel build
  (useful patterns for any future parallel work).

## Rules that must survive (the extension philosophy)

1. Extensions are plain React in the same build — no plugin runtime, ever.
2. Slots are the stable contract; core stays small; updates stay mergeable.
3. Tokens as CSS variables; primitives from `src/components/ui/`; no new CSS
   files; dark-first; no code comments unless asked.
4. Additive-only store/API changes; typecheck + build must pass.
5. v2-first: the v2 TUI + v2 API are the spec; v1 web is reference only for
   browser-layout patterns; never copy v1 features wholesale.
