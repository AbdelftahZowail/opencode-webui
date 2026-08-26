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
- **Streaming projection rebuilt** (2026-08-16): the live reducer now keeps
  text/reasoning parts by ordinal and tools by call ID in event order instead
  of merging separate text, reasoning, and tool buckets. SSE events are reduced
  in 16ms batches, duplicate event IDs are ignored, and disclosure state is
  keyed by stable part IDs so open reasoning/tool panels survive streaming and
  the live-to-history handoff. Poll reconciliation replaces updated messages,
  but leaves unfinished persisted assistants behind the live overlay. Verified
  with the two-prompt regression, a tool-heavy smoke run, and a live browser
  pass with reasoning opened while new events arrived.
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
     (replace updated messages, keep unfinished assistants behind the live
     overlay, and prune settled live assistants and optimistic local user
     messages once the real copy exists). A finished answer can never be lost
     behind a dead stream again.
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
  1. **Ordered live block**: `Conversation` renders ALL live assistants for the
     session in one growing block while preserving the engine's part order and
     stable part identity.
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
**User feedback is captured below. Each item is implemented against the existing
token/slot/dependency rules and verified with typecheck, build, and browser
checks where applicable.**
**Last round (2026-08-16) — status:**
- [x] Sidebar: workspace grouping with the three latest sessions per group +
      "Show N more…" + "Load more sessions" pagination. Session rows are
      native `/session/{id}` links with SPA history updates, direct-load and
      back/forward support, and modified/middle-click behavior left to the
      browser. Verified long titles ellipsize without widening the sidebar or
      hiding the delete control.
- [x] Sidebar follow-up: workspace collapse is now separate from "Show more"
      and resets the expanded list when reopened. Added a 56px useful icon rail
      collapse mode plus a pointer-drag resizer bounded to 240px-480px with
      double-click reset; spacing and group separators were also clarified.
- [x] The new-session controls are native `/new-session` links: normal clicks
      still create in-place, while middle/Cmd/Ctrl-click opens a new tab that
      creates the session and redirects to its canonical `/session/{id}` URL.
- [x] Removed the session-count labels from the bottom of the sidebar and the
      window-level runtime-status footer; the footer retains connection and
      active-run status without the redundant total.
- [x] "New session" creates AND focuses the new session (was already wired;
      also pins default model now).
- [x] Model selector reflects the real default agent/model (see DONE notes).
- [x] Live streaming nailed (see DONE notes) — verified by
      `scripts/uitest/two-prompt.sh` + `replay-store.mjs`.
- [x] Queued/waiting feedback for messages sent while a run is active or
      during provider cold start (see DONE notes).
- [x] Multi-step live rendering: ordered live block + compact continuation
      headers + empty-part skipping (see DONE notes). Verified in browser.
- [x] Streaming projection rebuild: ordered event parts, stable disclosure
      state, frame-batched deltas, and non-destructive live/history polling
      (see DONE notes). Verified in browser and with tool-heavy replay.
- [x] Full frontend+proxy debug logging (`/tmp/webui-debug.log`), clean
      start script (`scripts/start-dev.sh`), kill-by-PID guidance.
- [x] Visual confirmations from the user (2026-08-21): live streaming,
      multi-step rendering with tool cards, and second-message flow all
      confirmed working in the browser ("streaming almost perfect").

**TUI-parity round 2 (2026-08-22) — slash/arrow/tool-card parity:**
- [x] Slash built-ins completed against the v2 TUI palette: added `/undo`
  (abort + revert/stage at last user msg, text restored into composer via
  `revertPrompt`), `/redo` (stage forward or clear; reads
  `sessionDetails.revert.messageID`), `/copy` (transcript to clipboard),
  `/timestamps` (+pref, renders clock times in message headers),
  `/models` `/agents` `/themes` (open pickers via new `uiSignals` store ticks —
  the recorded follow-up), `/mcps` `/status` (openSettings(section)),
  `/diff` (opens FileExplorer), `/help` (keybind cheatsheet dialog).
  Skipped with reasons: `/share` `/unshare` (no route on our service),
  `/exit` `/editor` `/debug` (desktop-only), `/org` `/connect` `/warp`
  `/workspaces` (console/experimental), `/variants` (no variant list UI yet),
  `/timeline` (needs message anchors — follow-up), `/move` (WorkspacePicker
  supersedes). Verified in browser: menu lists + execute.
- [x] Staged-revert transcript view: service returns FULL history even when
  reverted; UI now cuts at `session.revert.messageID` (`applyRevertView`,
  same as TUI `messagesBeforeRevert`). Revert events reload messages+detail.
- [x] Arrow keys copied from the TUI keymap: composer ↑/↓ = prompt history at
  buffer start/end only (`src/lib/promptHistory.ts`, localStorage, mode
  restore incl. shell); ↓ on an empty input or at the very end opens the
  RunsPanel; unfocused ↑ = parent, ←/→ = cycle subagent siblings (TUI
  moveChild formula, wraps), ↓ = RunsPanel. `useHotkeys` now skips
  modifier-free combos on editable targets so plain arrows stay native while
  typing. All verified live in browser.
- [x] **RunsPanel** (`src/components/RunsPanel.tsx`, replaced an earlier
  centered-modal attempt): the v2 TUI's bottom subagents/shells widget,
  restyled to user screenshots — mono font, left accent border, "Subagents |
  Shell" tabs + esc hint + `tabs ←/→` footer. It REPLACES the composer while
  open (`store.runsPanelOpen` + `openRunsPanel`/`closeRunsPanel`; Conversation
  renders panel XOR composer). ↓/↑ walk the selection through ALL subagents
  (running first, finished included); ↑ at the very top closes and refocuses
  the composer so ↑ then walks prompt history; ←/→ switch tabs with wrap
  ("two lefts come back"); Enter opens; Esc closes. Keys are owned by a
  window CAPTURE-phase listener while open. Gotcha found & fixed: a
  session-change effect closed the panel on first mount (open tick raced the
  sessionID effect) — guarded by comparing against a prev-sessionID ref.
- [x] Tool cards rebuilt to the v2 TUI rendering model: inline icon+label rows
  (spinner/muted/red-expandable), block widgets for edit (real per-file diffs
  from `metadata.files[].patch` through DiffView — answer to "do code diffs
  work": yes, verified visually), write (numbered code), shell (command +
  output collapsed >10 lines, exit badge), subagent (opens child session),
  execute (↳ tool-call list). Tool-details OFF now hides completed tools
  (TUI shouldHide parity). Fixed vendored Command selectActive(-1) so Enter
  picks the first row without an initial ArrowDown.
- Note: our service's tool schema differs from upstream TUI expectations
  (`path` not `filePath`, `metadata.files[]` patches, `subagent` not `task`);
  ToolCard keys off OUR shapes (checked against live sessions).

**Slash round 3 (2026-08-23) — /variants, /skills, /connect:**
- [x] `/variants` + `VariantPicker` (`Pickers.tsx`): TUI DialogVariant parity —
  Default + one row per id from `Model.Info.variants` on `GET /api/model`;
  picker (and menu entry) hidden entirely when the current model has none
  (upstream `hidden:` parity). Selecting reuses `POST /session/{id}/model`
  with `variant` set on the ModelRef — verified live (persisted `@high`,
  cleared back). **Gotcha:** the service normalizes the unset state to
  `variant:"default"` rather than omitting it — ModelPicker label,
  MessageItem header, and VariantPicker all now treat `"default"` as unset
  (previously every pinned session rendered a spurious `@default`). Opens
  via a new `uiSignals.variants` tick, same pattern as /models /agents.
- [x] `/skills`: dedicated picker above the composer (runMenu-style dropdown,
  Esc/outside-click close) listing every engine skill; click = insert-or-
  activate via a shared `pickSkill` helper (same semantics as the slash-menu
  entries, which remain — this adds the TUI's browse UX on top).
- [x] `/connect`: opens Settings → Integrations. The upstream dialog's
  provider.oauth authorize/callback routes don't exist in our build; the
  integration-scoped connect routes are this engine's equivalent, and the
  Integrations section already implements key / OAuth-polling / command
  flows over them — so /connect is a one-liner like /mcps and /status.

**Composer polish round (2026-08-21, `c19f949`→`b2afa47`):**
- [x] Slash menu no longer steals focus from the textarea
      (`onOpenAutoFocus` prevented) — typing after "/" stays in the editor;
      all menu keys already route through the textarea's handler.
- [x] Meta-row chips became LISTS: agents chip opens every child session
      (running first, status dots, agent label) instead of jumping to the
      newest; shells chip lists real `shellList` commands with pid/status and
      click-expands inline output via `shellOutput`; Terminals group still
      routes to the shell panel. Child sessions show an "↑ Parent" header
      button (parent title as tooltip).
- [x] Hint line reads "Working… · esc to interrupt" during a run (`0621d61`).
- [x] Site-wide Esc interrupts the active run (`b2afa47`): useHotkeys handlers
      now receive the KeyboardEvent; App registers "escape" but yields when the
      composer owns the key (no double-interrupt) or an overlay
      (dialog/popover/cmdk) needs Esc to dismiss itself.
- [x] New sessions are created WITH the resolved default model instead of
      create-then-switch, so the engine stops persisting "Model switched to…"
      notes; historical model-switched messages are hidden from transcripts too.

**TUI-parity composer wave (2026-08-21, commits `1f90128`→`95e73e6`) — done:**
- [x] Composer rebuilt v2-TUI-style (`1f90128`): meta row inside the input box
      (shell-mode toggle, agent+model pickers MOVED HERE from the header,
      context readout = last-assistant tokens ÷ model limit.context + cost),
      dynamic hint line (status/spinner, shell esc-hint, keybinds, cwd),
      Tab/Shift+Tab agent cycling, dropdowns open upward, Send queues while
      running instead of disabling.
- [x] Request modals scoped per-session (`08db430`): Permission/Form/Question
      filtered by currentSessionID; foreign requests stay queued behind a
      bottom-right "N waiting elsewhere — switch" chip.
- [x] Live-block ordering fixed (`08db430`): optimistic msg_local_* rows force
      live placement below them (browser-vs-service clock skew made the
      timestamp comparison flip).
- [x] Esc stops a run; Stop clears spinner/badge instantly (`d214cce`).
- [x] Slash menu mirrors TUI autocomplete (`2c33b54`): flat alphabetized
      list (built-ins + commands + skills), trigger/hide rules incl.
      trailing-space nuance, execute-vs-insert select semantics, Enter never
      submits while open, Tab completes, Esc wipes query, fuzzy-ish filter
      over name/alias/description, built-ins wired (/new /sessions /thinking
      /rename /fork /export /compact with local dispatch).
- [x] Meta-row run indicators (`44f6a1b`): "▸ N agents" (children by parentID)
      and "⌨ M shells" chips → navigate/open ShellPanel; 5s poll paused on
      hidden tab; additive store shellPanelTick/requestShellPanel +
      childSessionsOf.
- [x] Ctrl+B backgrounds synchronous subagents (`d5d55cd`) via real
      api.sessionBackground() route (verified live, additive store action).
- [x] Subagents out of top-level lists (`95e73e6`): parentID sessions excluded
      from Sidebar groups/counts/pagination AND palette Sessions; new
      SubagentStrip under parent Conversation headers — children w/ running
      dots, Open, inline Message (additive sendPromptTo action).
- Follow-ups recorded: controlled Pickers/ThemePicker so /models /agents
  /themes built-ins can open them; spawn-subagent UI if engine ever allows
  parentID on POST /session; popover child-list for the agents chip;
  /timestamps needs a timestamps pref; palette is hand-curated vs upstream's
  registry-driven keymap (deliberate).
- **New-session send failing = dead model pinned in SERVICE config, not a UI
  bug** (2026-08-21): symptom was `session.execution.failed` ~60ms after
  `execution.started` with NO assistant message persisted (only the optimistic
  user message shows). Root cause: `~/.config/opencode/opencode.jsonc` pinned
  every agent to `opencode/deepseek-v4-flash-free`, which was rejecting runs
  instantly; the UI's model pinning then faithfully copied that dead model onto
  every new session (`resolveDefaultModel` → primary agent's model). Fix made in
  the service config, not the app: top-level `"model": "opencode-go/ox-alpha-free"`
  plus all three agents switched; the service hot-reloads config changes
  (verified via `/api/agent`). All existing sessions were re-pinned off the dead
  model through the API. Diagnostic recipe: diff `GET /api/session/{id}` between
  a working and a failing session (model + location), then reproduce headlessly
  with `scripts/uitest/create-session.sh` + `send-prompt.sh`. Remember the UI
  memoizes the default per page load (`defaultModelPromise`) — hard-refresh
  after changing agent models in config.

### 3. GIT — repository history and verification
- [x] Repository initialized with a sensible `.gitignore` and the whole working
      tree committed in `4482fad` (`Initial OpenCode web UI`).
- [x] `bun.lock` is included; generated `dist/` and `.vite` cache remain ignored.

### 4. PRODUCTION SMOKE TEST
- [x] `bun run build` + production server smoke-tested on isolated proxy `:4099`:
      `/` and an unknown SPA route served `dist/`, `/api/webui/status` reached
      the service, and a **PTY round-trip through the production websocket
      proxy passed** (`scripts/uitest/prod-pty-check.mjs`: create →
      connect-token → ws → echo → assert output). Prod instance killed by PID
      afterwards; dev on `:4097` untouched.
- [x] **Found + fixed a real websocket bug during that check** (2026-08-21):
      the proxy silently DROPPED client WS messages that arrived while its
      upstream service socket was still CONNECTING (`if OPEN` guard on send).
      Terminal input typed immediately after connect vanished — invisible in
      interactive use, exposed by the script's immediate send. Fix: buffer
      client messages in `pending` until upstream opens, then flush
      (`server/index.ts`). Round-trip verified through BOTH :4099 and :4097.

### 5. LONG-TAIL ROUTES — RESOLVED (2026-08-21), remainder intentionally skipped
- `serverInfo` already renders in Settings → Server; `serviceStop` too.
- `generate` (stateless one-shot completion — no session, streaming, or tools)
  and `referenceList` (engine reference bookkeeping) get NO UI by decision:
  the chat supersedes generate; references are opaque internals. The client
  fns stay in place (additive-only rule); revisit only if a real need appears.

### 6. EXTENSION AUTHORING TEST on the new UI
- [x] Added `ui-extensions/runtime-status/` through the documented flow:
      registered a footer slot, wired `ui-extensions/index.ts`, enabled the id
      in `config.ts`, and verified the native token-based status footer in the
      browser at desktop and `390px` widths.

### 7. RETEST `bun run preview` (5174/4098) — second-instance isolation.
- [x] Started the isolated preview and verified `5174/` plus `/api/webui/status`
      through proxy `:4098`; stopped only the temporary preview process tree.

### 8. HOUSEKEEPING
- [x] Deleted leftover test session prefix `ses_ff9ee78e` (full id
      `ses_ff9ee78e5ffeu8kkUgrMyIaG1m`) from the session list after the service
      restart. The API returned `204`; the record is absent from the live API
      and the fresh browser session list. Removed the temporary empty
      `playground/` directory used to satisfy the stale location.
- [x] Reference material salvaged (2026-08-21): /tmp had already been WIPED
      (`opencode-src` clone + extracted theme CSS gone), so the OpenAPI spec
      was regenerated LIVE into `docs/reference/openapi.json` via the new
      `scripts/fetch-openapi.ts` (Service discovery + auth, same as the proxy).
      Theme tokens live on in `src/styles.css`; re-clone upstream if the rest
      is ever needed.
- [x] AGENTS.md roadmap table and current frontend behavior notes are up to
      date; the roadmap has no pending API surface entries.

### 9. DEFERRED — bundle code-splitting
Initial JS chunk is ~1MB minified / ~286KB gzip. Acceptable on localhost; only
worth doing (`React.lazy` + Suspense around Settings hub / FileExplorer /
ShellPanel — xterm is the heavy part) if the webui is ever served over a
network. Revisit at deploy time.

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
src/components/Composer.tsx        slash menu + @ refs + ! bash + prompt history
src/components/RunsPanel.tsx       subagents/shells strip (replaces composer while open)
src/components/HelpDialog.tsx      /help keybind cheatsheet
src/components/ToolCard.tsx        tool cards, v2-TUI style (extension hook: getToolRenderer)
src/components/Sidebar.tsx         grouped session rail + workspace collapse + resize/icon rail + Files/Shell/Settings/Inbox
src/components/Pickers.tsx         agent/model pickers (authoritative session detail)
src/components/ShellPanel.tsx      shell mgmt + terminals (TerminalView)
src/components/TerminalView.tsx    xterm terminal emulator
src/components/FileExplorer.tsx    fs tree + preview + diff (DiffView)
src/components/settings/           settings hub sections
src/components/PendingRequestsPanel.tsx  permissions/questions/forms — replaces composer (own session), corner chip (others)
src/components/InboxPanel.tsx      inbox queue/steer
src/theme/themes.ts                7 themes (applyTheme :root:root injection)
src/prefs.ts                       showReasoning/showToolDetails/showTimestamps prefs
src/lib/promptHistory.ts           localStorage prompt history (↑/↓ in composer)
src/hooks/useHotkeys.ts            ctrl+p / ctrl+n / escape + TUI arrow bindings
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
| `prod-pty-check.mjs` | PTY websocket round-trip against `$BASE` (create → token → ws → echo assert); works on prod and dev proxies |
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

## Reference material

- **`docs/upstream-references.md` — READ THIS for upstream help**: what the
  local `anomalyco/opencode` checkouts (`~/opencode-reference` = dev,
  `~/opencode-reference-v1` = v1.18.9) contain, what each package is good for
  (session-ui spec, their v2 event reducer, SDK types, TUI dialogs), and
  verified findings (their web app is hybrid/Solid/non-extensible and does NOT
  work against our service).
- `docs/reference/openapi.json` — the live v2 OpenAPI spec snapshot
  (authoritative for field names). Refresh with `bun run scripts/fetch-openapi.ts`.

## Rules that must survive (the extension philosophy)

1. Extensions are plain React in the same build — no plugin runtime, ever.
2. Slots are the stable contract; core stays small; updates stay mergeable.
3. Tokens as CSS variables; primitives from `src/components/ui/`; no new CSS
   files; dark-first; no code comments unless asked.
4. Additive-only store/API changes; typecheck + build must pass.
5. v2-first: the v2 TUI + v2 API are the spec; v1 web is reference only for
   browser-layout patterns; never copy v1 features wholesale.
