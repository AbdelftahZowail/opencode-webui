# opencode-webui

A web frontend for the OpenCode v2 engine. The engine is the **opencode
background service** (a separate process); this project is only a client of
its HTTP API. Inspired by DeepSeek Harness's web UI (`dsh web`) and its
client-plugin architecture, but deliberately dependency-free on the UI side:
no plugin framework — just a clean React app that is easy to edit, with hot
reload everywhere.

## Architecture

```
browser ──/api──> Bun proxy server (server/index.ts) ──auth──> opencode service
   ▲                                                              (owns sessions,
   └────────── dist/ served by the proxy in production           agents, tools)
```

- **The browser never holds service credentials.** The proxy discovers the
  service with `Service.ensure()` from `@opencode-ai/client/service` and
  attaches auth headers. Do not bypass the proxy.
- **Dev**: `bun run dev` starts the proxy (port 4097, `WEBUI_PROXY_PORT`)
  and Vite (5173, `WEBUI_VITE_PORT`) together; Vite proxies `/api` to the
  proxy. HMR applies to every UI edit instantly — no refresh, no restart,
  and the opencode service is never restarted.
- **Preview**: `bun run preview` starts a SECOND dev instance on dedicated
  ports (Vite 5174, proxy 4098) — a fresh page for reviewing WIP edits
  without touching the main app or production.
- **Prod**: `bun run build && bun start`; the proxy serves `dist/` and the
  API on port 4097.

## Where things live

| Path | Purpose |
| --- | --- |
| `server/index.ts` | Bun proxy: service discovery, auth, `/api/*` passthrough, static serving |
| `src/api/types.ts` | All API schemas — copy from the service's `/openapi.json` (the contract) |
| `src/api/client.ts` | Typed REST client (one function per endpoint) |
| `src/api/events.ts` | SSE parser for `/api/event` + reconnection |
| `src/lib/scheduler.ts` | The one fetch/tick scheduler — tiers (live/idle/hidden), registered pollers, no component-owned `setInterval` |
| `src/store.ts` | Central state: sessions, messages, live streaming, permission/form queues, event reducer |
| `src/components/` | UI: `Sidebar`, `Conversation`, `MessageItem`, `ToolCard`, `Composer`, `Pickers`, `RunsPanel`, `QueueStrip` (pending steers/queue), `PendingRequestsPanel` (permissions/questions/forms), `ui` (primitives) |
| `src/extensions/registry.tsx` | The slot registry — the stable contract for UI extensions (do not change lightly) |
| `ui-extensions/` | Feature folders; `index.ts` wires them in. Authoring guide: `ui-extensions/README.md` |
| `docs/reference/openapi.json` | Versioned OpenAPI snapshot — "last covered" contract (see `docs/coverage.md` + `scripts/diff-openapi.ts`) |
| `docs/coverage.md` | Have / don't-have / why matrix — so intentional skips don't read as missing work |
| `AGENTS.md` | This guide |

## How the chat UI works

- History comes from `GET /api/session/{id}/message` (desc, reversed).
- Live output comes from the SSE stream (`/api/event`). The store's
  `handleEvent` reducer builds a "live assistant message" from
  `session.text.*`, `session.reasoning.*`, `session.tool.*`,
  `session.step.*` and `session.execution.*` events, keyed by
  `assistantMessageID`. Tool input arrives as streaming JSON
  (`session.tool.input.delta`) until `input.ended` parses it.
- Permission requests arrive as `permission.asked` events and are answered
  via `POST /api/session/{id}/permission/{requestID}/reply`
  (`once` | `always` | `reject`).
- **Pending requests** (`PendingRequestsPanel` + corner chip): permissions,
  questions and forms share ONE FIFO queue in the store (each entry gets a
  `seq` stamp at insertion). The FOCUSED session's head request REPLACES the
  composer slot — RunsPanel idiom, not a dialog — until answered; Esc
  rejects/cancels it via a capture-phase key owner (a stacked dialog gets
  Esc first), focus parks on the box so a stray Enter can't Reject, and the
  panel never dismisses on outside clicks. Requests from OTHER sessions pop
  the amber corner chip ("N waiting in other sessions — switch"). Queues
  re-fetch every ~10s on the poll cadence, so a missed SSE event can never
  leave an agent blocked unnoticed; `refreshQueues` fetches each endpoint
  independently. On this engine version mid-task questions arrive as
  `form.created` events with `metadata.kind === "question"` (fields q0…qn,
  field-level `custom`/`multiple` flags, replies shaped `{"q0": value}`) and
  there are NO question REST routes — `pendingRequests()` projects those
  forms into question entries and reply/reject route through the form
  endpoints (multi-select fields must answer as arrays, singles as strings;
  a failed submit keeps the form pending and retryable); native
  `question.asked` events feed the same shape for future engines.
- Forms arrive via `/api/form/request` and are answered with
  `POST /api/session/{id}/form/{formID}/reply`.
- When the UI sends a prompt it is fire-and-forget: `POST .../prompt` only
  queues the message; the events drive everything rendered. While the
  session is BUSY, a send never touches the transcript: it becomes a
  durable engine inbox entry rendered by `QueueStrip` above the composer —
  ⚡ steer (delivered at the next LLM-call boundary, the engine default)
  vs ⏳ queue (parked until the turn ends; a post-turn drain failsafe flips
  the head item to steer if the engine doesn't advance it). Rows can be
  flipped between the two, deleted, or sent now (`inbox/{id}/steer` wakes
  execution); the steer group offers interrupt-and-flush via
  `interrupt?continue=true`. Enter = steer, Ctrl/Cmd+Enter = queue. Idle
  sends keep the optimistic transcript bubble exactly as before.
- **Model pinning**: new sessions are created WITH the resolved default
  (`resolveDefaultModel()` passed into `POST /session`) — creating model-less
  and switching after made the engine persist a "Model switched…" message in
  every fresh session. Legacy unpinned sessions still get pinned on first send
  (`ensureSessionModel` via `POST .../model`). The pickers read the
  authoritative `GET /api/session/{id}` from the `sessionDetails` store slice.
- **Esc** interrupts the active run site-wide in TWO steps (`requestInterrupt`):
  the first press only arms it — the composer's status line swaps to a yellow
  "press esc again" hint that self-reverts after 2.5s — and the second press
  aborts. Esc still yields to the composer when it's focused and to any open
  overlay (dialog/popover/menu) that needs Esc to dismiss itself.
- **Composer drafts** (`src/lib/drafts.ts`): unsent input is silently saved
  per session (localStorage) on every change and restored when the session
  returns; cleared on send. No UI, no labels.
- **Split view** (`panes` in the store): VS Code-style panes — the routed
  main surface plus up to 3 pinned sessions, each a fully interactive
  Conversation+Composer (sends/SSE are per-session; unfocused panes have no
  live projection and catch up on the 2s poll). Exactly ONE pane is focused
  and owns the global single-session machinery (live streaming, Esc
  interrupt, dirty agent/model picks, RunsPanel/pending-panel composer slot,
  type-anywhere); focusing a pane repoints `currentSessionID` WITHOUT
  touching history/drafts/pane bindings, so switches paint instantly from
  cache. Open via the right-edge rail button or `ctrl+\`
  (`SplitPicker`: type-to-filter over sessions, or "Start new session" in
  any project workspace via `createRealSession`); close with the pane's ✕;
  layout persists in localStorage and prunes dead sessions at boot.
  In-pane navigation (parent buttons, subagent chips, arrows) routes through
  `navigateFocused`. Subagents are excluded from the agent picker
  (`mode === "primary"` only) and from the SplitPicker list (parentID set).
- **Session navigation**: session rows are native `/session/{id}` anchors.
  Unmodified left-clicks switch sessions in place through `pushState`; browser
  back/forward uses `popstate`, and direct session URLs load the conversation.
  Modified clicks and middle-clicks remain native browser actions. The New
  session control is a native `/new-session` anchor; its route creates a session
  and replaces itself with the new session's canonical URL, so opening it in a
  new tab creates the session in that tab. New sessions inherit the open
  session's workspace (`startDraftSession`: explicit picker choice > sidebar
  pending target > open draft's binding > current session's directory, with
  a subagent falling back to its parent's — engine subagents carry no
  location of their own).
- **Sidebar behavior**: workspaces are grouped by directory and show the three
  newest sessions by default. Each workspace header independently collapses all
  rows; reopening resets the separate `Show N more…` expansion state. The
  sidebar itself can collapse to a 56px icon rail and resize from 240px to
  480px, with double-click on the divider restoring 288px. Subagent sessions
  (parentID set) are excluded from top-level lists/counts and managed inside
  their parent conversation (SubagentStrip: open/message children).

## Rules for editing

1. **Never change the contract layer without the OpenAPI doc.** Before
   touching `src/api/types.ts` or `client.ts`, diff against the running
   service: `bun run scripts/fetch-openapi.ts` writes the live spec to
   `docs/reference/openapi.json` (the proxy forwards only `/api/*`, not
   `/openapi.json`). Check drift with `bun run scripts/diff-openapi.ts` and
   update the coverage matrix in `docs/coverage.md` (have / don't-have / why) so
   intentional skips stay intentional.
2. **Keep the store as the only place state lives.** Components read via
   `useStore((s) => ...)` and call actions; they never fetch directly except
   for one-shot catalog data (`models`, `agents`, `commands`, `skills`).
3. **Hot reload contract**: editing any file under `src/` applies
   immediately via Vite HMR. Adding a new file may trigger one full reload
   (Vite limitation) — that is expected. Full-page reloads are COALESCED by
   `coalesceFullReload()` in `vite.config.ts`: they wait ~1s of filesystem
   quiet (hard 10s cap), so agent/human save bursts cost one reload instead
   of many; root-level non-module files (`.md`, `docs/**`, `.codegraph/`)
   aren't watched at all — they used to force spurious full reloads through
   @tailwindcss/vite. Component files must export COMPONENTS ONLY: any
   runtime non-component export disables React Fast Refresh for the whole
   file and turns each save into an invalidation cascade (see
   `filterSlashEntries` history in Composer.tsx). Editing `server/index.ts`
   restarts the proxy automatically (`bun run --watch`), which drops the
   SSE stream; it reconnects by itself. Never restart the opencode service
   for UI work.
4. **Styling** is Tailwind v4 utility classes, dark-first. New components
   should not introduce new CSS; `styles.css` is only for global chrome.
5. **Keep it dependency-light.** React, react-markdown, shadcn/ui (vendored
   source), Radix (vendored), lucide-react, and the Tailwind stack are the
   intended surface. Approved runtime exceptions, justified:
   - `@shadcn/react` — headless MessageScroller (tested scroll behavior; the hard part we won't hand-roll)
   - `@xterm/xterm` + `@xterm/addon-fit` — the PTY terminal emulator (same lib VS Code uses; ANSI/terminal semantics can't be hand-rolled sanely)
   If a new dependency is needed, prefer small, well-known packages and say why.

## Extensions (not plugins — read this before adding UI features)

Frontend features are **plain React code** living in `ui-extensions/<name>/`,
auto-discovered by `ui-extensions/index.ts` (drop the folder, that's the
install). They register against a small vocabulary of **kinds**:

| Kind | What it does | Surfaces via |
| --- | --- | --- |
| `region` | renders into any `<Slot region="…">` marker in core markup | generated table: `bun run regions` |
| `command` | palette action (`Extension commands` group) — add `keybind:"ctrl+shift+k"` for global hotkey | palette (⌘/ctrl-K) + keybind |
| `slash` | UI-only slash entry for Composer `/name` (local `run(args,{sessionID})`; engine slash via engine plugin + `GET /api/command`) | Composer `/` autocomplete |
| `message` | full replacement for any message type (`type:"system"\|"synthetic"\|"shell"\|…\|"*"`, `render({message, sessionID})`) — first non-null wins, else core `renderMessageBody` | `MessageItem` per message |
| `message.decoration` | per-message extras (`render({ messageID, message }) => node \| null`) | under every message row |
| `message.part` | inject after each text/tool/reasoning part inside a message | inside `MessageItem` per part |
| `tool.renderer` | custom card for a specific tool name | `ToolCard` per tool |
| `contextMenu` | right-click item `target:"message"\|"session"\|"file"` | context menu |
| `hook` | intercept `session.prompt` (mutate `ctx.text`), `message.render` (mutate `ctx.message`), `store.dispatch` (observe) — `event:string` open so new seams need no registry bump | store + `MessageItem` + `Composer` |
| `page` | full surface at auto-route `/ext/{id}` | sidebar links + direct URL |
| `settings` | titled section inside Settings › Extensions | Settings dialog |
| toasts | `window.__opencodeUI.notify({title, variant})` | bottom-right stack, 3s |

- **Add a feature**: create `ui-extensions/<name>/index.tsx`, call
  `register({ kind, ... })`, export its `id`, keep the trailing
  `import.meta.hot.accept()` line. Edits hot-swap live; adding a folder is
  hot; DELETING a folder costs one coalesced reload.
- **Disable**: remove its id from the `enabled` list in
  `ui-extensions/config.ts`.
- **Full app access**: extensions are the same build — they can use
  `useStore`, `api`, and any component. No plugin API to learn.
- **The kinds + region list is the contract** (`src/extensions/registry.tsx`
  owns it). Adding a REGION MARKER is a one-line, always-welcome change —
  drop `<Slot region="area.thing" />` where needed and run
  `bun run regions`. Adding a new KIND is a deliberate contract change:
  edit registry.tsx + document here and in `ui-extensions/README.md`.
  Never build speculative kinds.
- No plugin framework is intentional: plugins cost type safety, hot reload,
  and freedom, and their benefits (runtime toggles, third-party isolation)
  are not needed for a single-author codebase. Sharing with others = npm
  package + one folder. See `ui-extensions/README.md`.

## Extending (roadmap, dsh-inspired)

| Area | OpenCode API | Status |
| --- | --- | --- |
| Sessions, chat, streaming, tool cards | session/message/event routes | ✅ done |
| Permission approval | permission routes | ✅ done |
| Forms | form routes | ✅ done |
| Model/agent switching | model/agent routes | ✅ done |
| Slash commands, skills | command/skill routes | ✅ done |
| @ file references, ! bash prefix | fs/location/session shell routes | ✅ done |
| Session actions (rename/fork/export/compact) | session routes | ✅ done |
| Thinking + tool-details toggles, command palette, hotkeys | prefs + event handling | ✅ done |
| Themes (7, from v2 TUI palettes) | n/a (frontend tokens) | ✅ done |
| Diff view (in file explorer) | vcs routes | ✅ done |
| Workspace picker (location) | location/project routes | ✅ done |
| File explorer + diff view | filesystem/vcs routes | ✅ done |
| Shell/PTY panels | shell/pty routes | ✅ done (incl. live terminal emulator via websocket) |
| Settings (providers, integrations, plugins, MCP) | provider/integration/plugin/mcp routes | ✅ done |
| VCS status badge | vcs routes | ✅ done (in file explorer) |
| Inbox/steering while busy | session inbox routes | ✅ done |
| Question dialog (mid-task) | question routes | ✅ done |
| Idle wait (engine-native run end) | `POST /api/session/{id}/wait` | ✅ done (per-running-session long-poll in the store) |
| UI extensions (slots) | n/a (frontend convention) | ✅ done |

The "everything the engine can do must eventually be reachable from the UI"
principle: each API resource group gets a UI surface, in the order above.

## Commands

- `bun run dev` — proxy + Vite with HMR
- `bun run preview` — second dev instance on 5174/4098 for reviewing WIP edits
- `bun run typecheck` — `tsc --noEmit`
- `bun run build && bun start` — production build, served on 4097
- `scripts/start-dev.sh` — clean detached start with debug logging
  (frontend → `/tmp/webui-debug.log`, server → `/tmp/webui-server.log`).
  Stop by PID (`ps aux | grep -E "bun run|vite"`), never `pkill -f`.
- `scripts/uitest/*` — reusable UI/service checks (create/send/wait/messages,
  event-capture, store-replay streaming proof, default-model pin check,
  multi-prompt regression). See HANDOFF.md — "UI test scripts".

## Live streaming (how it's made robust)

The service emits one assistant message per step (reasoning / tool / text)
and in this deployment often NO `session.execution.*` events — so the store
treats the step events as the run lifecycle and keeps an ordered live projection:

- **Proxy-side event recorder** (`server/index.ts`): the proxy keeps ONE
  always-on service-side subscription and a bounded per-session ring buffer
  (400 events / 512KB / 10min TTL). The engine serves NO mid-stream text over
  REST (part skeletons arrive with `text:0`) and does NOT replay a fresh
  `/api/event` subscription — so a browser that attaches, reloads or
  reconnects mid-run pulls the gap from `GET /api/webui/replay?sessionID=X`
  (`fetchReplay` in the store, on session adopt + SSE reconnect) and feeds it
  through the normal event path; id-based dedupe and overlap-safe delta
  appends make replays harmless. `scripts/uitest/catchup-check.ts` proves a
  late join reconstructs the stream.

- **`store.queued` ("waiting")**: set optimistically on every send AND on
  `session.inbox.enqueued`; cleared on the first live event
  (`execution.started` / `step.started` / `text.started`). Covers both the
  provider cold-start gap (~15s) and messages queued behind an active run.
- **`running` fallback**: if `execution.started` never arrives, a
  `step.started` for a queued session promotes it to running; the final
  `step.ended` with `finish:"stop"` clears it (`seenExecution` remembers
  sessions with real execution events so they keep the canonical path).
- **Ordered live parts**: each live assistant keeps text/reasoning parts by
  event ordinal and tools by call ID, in event order. The renderer never
  rebuilds a stream as separate reasoning → text → tools buckets.
- **Frame-batched events**: SSE events are reduced in 16ms batches so a burst
  of token deltas produces one React update instead of one render per delta.
- **SSE watchdog** (`events.ts`): if no bytes arrive for 20s (heartbeats come
  every ~15s) the reader is cancelled and the stream reconnects; its byte-age
  health signal (`sseStale()`) is what the scheduler reads to decide the REST
  fallback tier. Stall lines carry `rx=<bytes>` — the dead connection's total
  intake, proving whether it EVER received bytes.
- **The SSE "wedge" — SOLVED (2026-08-31)**: Bun's default `idleTimeout`
  (10s) killed any proxy socket silent for 10s, while the engine heartbeats
  every 15s — idle connections were guaranteed to die before the next
  heartbeat, and vite never learned its upstream died, so the browser sat
  until its 20s fuse. Active runs masked it (constant bytes). Fix:
  `idleTimeout: 0` in `Bun.serve` — liveness is owned by heartbeats, the
  browser fuse, and `req.signal` aborts. This also lets `session.wait`
  long-polls hold (they were silently churning on 10s kills). The temporary
  `[ssehop]` per-hop byte counters that proved this were removed after a
  clean soak (zero wedges since the fix; they lived in `server/index.ts`
  and `vite.config.ts`, see git history if the pattern ever returns).
- **Recorder → cursor-replay swap** (the one open item): the engine's
  durable per-session log will replace the proxy recorder's catch-up once
  a build serves backlog (`follow=true` streams nothing on beta-18684).
  Run `bun run check:swap` after engine bumps — when it prints READY (with
  captured wire shapes), follow its 3-step runbook; the client already
  tracks the cursor (`logHeadSeq`).
- **Fetch scheduler** (`src/lib/scheduler.ts`): the ONLY owner of recurring
  timers. One 1s loop picks a tier — LIVE ~2s (anything running/queued/
  pending/live, or the SSE byte-age is stale), IDLE ~12s (visible, quiet tab),
  HIDDEN ~60s (document.hidden) — and runs registered pollers
  (`messages`/`queues`/`sessions` in the store, plus composer/panels/
  extensions pollers) no more often than their per-tier interval, with
  registration jitter and in-flight guards. Components never own
  `setInterval`; they `registerPoller()` or derive from store state. A
  visibilitychange kick catches up due pollers on tab return.
- **Poll fallback** (`store.pollOnce`): on the scheduler's LIVE tier the
  running/queued/pending/live sessions' messages are fetched and reconciled —
  replace newer copies of existing messages, keep unfinished persisted
  assistants behind the live overlay, and drop optimistic `msg_local_` copies
  once the real message exists; sessions whose fetches keep failing (404 ⇒
  immediately, otherwise after 3 tries) are retired (flags, live entries,
  pending rows, replay cursor) so a deleted session can't 404-loop forever. A
  finished answer can never be lost.
- **`session.wait` long-poll** (`store.ensureSessionWait`): one loop per
  running session — `POST /api/session/{id}/wait` resolves 204 the moment
  the engine's agent loop goes idle (spike-verified: completion, already-
  idle, and failed runs all resolve; never hangs). On 204 with a still-set
  running flag we missed the terminal event (dead SSE): clear it, settle
  history. Armed on execution/step events, on sends (idle + busy paths),
  and on active-map discovery — the floor under the §7 staircase. Anything
  but 204 re-arms; 404 retires. `queued` is never cleared by wait (parked
  inbox items resolve via `reconcileInbox`).
- **`settleLiveMessages`**: on execution end, reload history; if live
  assistants aren't persisted yet, keep them visible and retry once after
  1.5s.
- **`adoptPendingAssistant`**: `execution.started` has no assistant message
  id; `step.started` re-keys the "pending" placeholder to the real id so no
  duplicate "thinking…" block shows.

## Rendering (live vs history)

- **Ordered live block**: `Conversation` renders all live assistants for the
  session in ONE growing block, ALWAYS below the entire persisted transcript
  (persisted = history, streaming = now). Timestamp-anchored placement mixed
  client/server clocks and let stale live entries float above fresh messages.
- **Ghost live GC** (`applyFetchedMessages`): a live assistant that never
  persisted and whose session is idle is retired after ~30s so it can't
  drag rendering or run-state forever.
- **Compact continuation messages**: consecutive assistant messages render
  without the repeated `agent provider/model@variant` header — only the first
  in a group shows it.
- **`liveToolPart`** (store): builds the exact `ToolPart`/`ToolState` shape
  from a live tool (streaming input = raw `inputText`, then parsed) — the
  ToolCard reads `part.state`, never crashes on a missing state.
- Empty text parts (e.g. the `"\n\n"` step stub) are skipped.
- **Staged-revert view**: with `session.revert.messageID` set, the transcript
  is cut at that message (`applyRevertView`) — the service still returns full
  history; `/redo` steps forward or clears.

## Tool cards (v2 TUI style)

Tools render as ONE inline row (icon + label, muted when done, spinner while
running, red + expandable on failure). Rich results get a titled block:
`edit` shows per-file diffs from `metadata.files[].patch` via DiffView,
`write` shows the file with line numbers, `shell` shows command + output
(collapsed past 10 lines), `subagent` links to the child session, `execute`
lists its tool calls. With tool details OFF, completed tools hide entirely
(TUI parity). Extension renderers still win via `getToolRenderer`.
Nested `execute` calls show an inline argument preview
(`↳ tool [key=value …]`, truncated) — rows with details highlight on hover
and click to reveal the full input/output/error (state persisted per row).

## Arrow keys & prompt history (v2 TUI bindings)

- Composer focused: ↑/↓ walk prompt history ONLY from buffer start/end
  (`src/lib/promptHistory.ts`, localStorage-backed); otherwise caret moves.
  ↓ at the very end with nothing newer opens the RunsPanel — so does ↓ on an
  empty input. Left/right always move the caret.
- Composer unfocused: ↑ parent session, ←/→ cycle subagent siblings (wrap),
  ↓ opens the RunsPanel.
- **RunsPanel** (`src/components/RunsPanel.tsx`): the v2 TUI's bottom
  subagents/shells widget — a left-accent-bordered strip that REPLACES the
  composer while open (`store.runsPanelOpen`; not a modal). Tabs switch
  Subagents ↔ Shell (←/→ wrap; click works), ↓/↑ move the selection through
  ALL subagents (running first, finished included), Enter opens, ↑ AT THE TOP
  or Esc closes and returns focus to the composer so ↑ then walks history.
  Keys are consumed in a window CAPTURE-phase listener while open. Opened
  from a subagent page the list anchors at the PARENT (siblings + self),
  tracked by session ID, with the open session pre-selected and ▸-marked.
  (Printable keys are handled site-wide — see "Type-anywhere → composer"
  below.)
- Modifier-free combos never fire while typing (`useHotkeys` skips editable
  targets), so plain keys always belong to the text surface.
- **Subagent pages open read-only** (`store.subagentComposerOpen`): the
  composer is replaced by a MINIMAL horizontal strip — one small chip per
  sibling subagent (id order, the same order ←/→ cycle; the open session's
  chip is highlighted, running siblings pulse green) over the "enter to
  message this subagent · ↑ back to parent" actions. Enter reveals the
  composer (site-wide binding; the gate resets on every session switch),
  Backspace returns to the parent both while gated and with the composer
  revealed (empty buffer only — handled in Composer when the textarea owns
  focus, in App otherwise).
- **Type-anywhere → composer** (`src/lib/composerHandoff.ts`, listener in
  `App.tsx`): a printable key pressed while focus sits on any non-editable
  surface (messages list, sidebar, runs-panel box) focuses the composer and
  lands the character as if typed; on gated subagent pages the gate comes
  down first. Skipped while dialogs/command palette/menus/popovers are up
  and for ctrl/meta/alt combos (AltGr kept).
- **Browser chrome**: the tab title mirrors the open session's title with a
  `●` prefix while that session is running/queued (effect in `App.tsx`);
  the favicon is the OpenCode logo (`public/assets/opencode.svg`).

## Model pinning & pickers

New sessions are created WITH the resolved default (`resolveDefaultModel()`
passed into `POST /session`) so no "Model switched…" note is persisted. Legacy
unpinned sessions get pinned on first send (`ensureSessionModel` via
`POST .../model`). The pickers read the authoritative `GET /api/session/{id}`
from the `sessionDetails` store slice. The model picker has a type-to-filter
search box (autofocused on open; filters name/model/provider; ↑/↓ + Enter
select over the filtered list; Esc clears the query first, then closes).

## Debug logging

The frontend logs (`[boot] [sse] [evt] [gate] [run] [session] [send] [model]
[load] [poll]`) POST to the proxy's `/api/debug` sink, which appends to
`$WEBUI_DEBUG_LOG` (default `/tmp/webui-debug.log`). Server/proxy logs go to
stdout when `WEBUI_DEBUG=1`. Console mirror: set
`localStorage.webui.debug = "1"` and reload. See HANDOFF.md — "Debugging the
streaming path".
