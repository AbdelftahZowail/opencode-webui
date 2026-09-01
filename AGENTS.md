# opencode-webui

A web frontend for the OpenCode v2 engine. The engine is the **opencode
background service** (a separate process); this project is only a client of
its HTTP API. Deliberately dependency-free on the UI side: no plugin
framework — just a clean React app that is easy to edit, with hot reload
everywhere.

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
| `server/index.ts` | Bun proxy: service discovery, auth, `/api/*` passthrough, static serving, event recorder |
| `src/api/types.ts` | All API schemas — copy from the service's `/openapi.json` (the contract) |
| `src/api/client.ts` | Typed REST client (one function per endpoint) |
| `src/api/events.ts` | SSE parser for `/api/event` + reconnection + watchdog |
| `src/lib/scheduler.ts` | The one fetch/tick scheduler — tiers (live/idle/hidden), registered pollers, no component-owned `setInterval` |
| `src/store.ts` | Central state: sessions, messages, live streaming, permission/form queues, event reducer |
| `src/components/` | UI: `Sidebar`, `Conversation`, `MessageItem`, `ToolCard`, `Composer`, `Pickers`, `RunsPanel`, `QueueStrip`, `PendingRequestsPanel`, `ui` (primitives) |
| `src/extensions/registry.tsx` | The slot registry — the stable contract for UI extensions (do not change lightly) |
| `ui-extensions/` | Feature folders; `index.ts` wires them in. Authoring guide: `ui-extensions/README.md` |
| `docs/reference/openapi.json` | Versioned OpenAPI snapshot — "last covered" contract (see `docs/coverage.md` + `scripts/diff-openapi.ts`) |
| `docs/coverage.md` | Have / don't-have / why matrix — so intentional skips don't read as missing work |

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
  questions and forms share ONE FIFO queue in the store. The focused
  session's head request REPLACES the composer slot (RunsPanel idiom, not a
  dialog) until answered; requests from other sessions pop the amber corner
  chip. Queues re-fetch on the poll cadence so a missed SSE event can never
  leave an agent blocked. Mid-task questions arrive as `form.created`
  events with `metadata.kind === "question"`; reply/reject route through
  the form endpoints (multi-select answers as arrays, singles as strings).
- Forms arrive via `/api/form/request` and are answered with
  `POST /api/session/{id}/form/{formID}/reply`.
- **Sending while busy**: prompts are fire-and-forget; the events drive
  everything rendered. While the session is BUSY a send becomes a durable
  engine inbox entry rendered by `QueueStrip` — ⚡ steer (next LLM-call
  boundary, Enter) vs ⏳ queue (parked until turn end, Ctrl/Cmd+Enter).
  Rows can be flipped, deleted, or sent now.
- **Model pinning**: new sessions are created WITH the resolved default
  (`resolveDefaultModel()` passed into `POST /session`); legacy unpinned
  sessions get pinned on first send (`ensureSessionModel`). The pickers
  read the authoritative `GET /api/session/{id}` from the `sessionDetails`
  store slice.
- **Esc** interrupts the active run site-wide in TWO steps
  (`requestInterrupt`): first press arms (yellow hint, self-reverts after
  2.5s), second press aborts. Esc yields to the focused composer and to
  open overlays.
- **Composer drafts** (`src/lib/drafts.ts`): unsent input is silently saved
  per session (localStorage) and restored when the session returns.
- **Split view** (`panes` in the store): the routed main surface plus up to
  3 pinned sessions, each a fully interactive Conversation+Composer.
  Exactly ONE pane is focused and owns the global single-session machinery;
  focusing a pane repoints `currentSessionID` without touching
  history/drafts. Open via `ctrl+\` (`SplitPicker`); layout persists in
  localStorage. Subagents are excluded from the agent picker and
  SplitPicker.
- **Session navigation**: session rows are native `/session/{id}` anchors
  (in-place `pushState` switches, `popstate` back/forward, modified clicks
  stay native). The New session route creates a session and replaces
  itself with the new session's canonical URL; new sessions inherit the
  open session's workspace (`startDraftSession`).
- **Sidebar**: workspaces grouped by directory, three newest sessions
  shown, collapsible per header; sidebar collapses to a 56px rail and
  resizes 240–480px. Subagent sessions (parentID set) are managed inside
  their parent conversation (SubagentStrip).

## Rules for editing

1. **Never change the contract layer without the OpenAPI doc.** Before
   touching `src/api/types.ts` or `client.ts`, diff against the running
   service: `bun run scripts/fetch-openapi.ts` writes the live spec to
   `docs/reference/openapi.json`. Check drift with
   `bun run scripts/diff-openapi.ts` and update `docs/coverage.md`.
2. **Keep the store as the only place state lives.** Components read via
   `useStore((s) => ...)` and call actions; they never fetch directly
   except for one-shot catalog data (`models`, `agents`, `commands`,
   `skills`).
3. **Hot reload contract**: editing any file under `src/` applies
   immediately via Vite HMR. Full-page reloads are coalesced by
   `coalesceFullReload()` in `vite.config.ts` (~1s of filesystem quiet);
   root-level non-module files (`.md`, `docs/**`) aren't watched. Component
   files must export COMPONENTS ONLY — any runtime non-component export
   disables React Fast Refresh for the whole file. Editing `server/index.ts`
   restarts the proxy automatically (`bun run --watch`), which drops the
   SSE stream; it reconnects by itself. Never restart the opencode service
   for UI work.
4. **Styling** is Tailwind v4 utility classes, dark-first, consuming design
   tokens from `src/styles.css` as `var(--...)` — never hardcode hex. New
   components should not introduce new CSS.
5. **Keep it dependency-light.** React, react-markdown, shadcn/ui
   (vendored), Radix (vendored), lucide-react, and the Tailwind stack are
   the intended surface. Approved exceptions: `@shadcn/react` (headless
   MessageScroller) and `@xterm/xterm` + addon-fit (PTY terminal
   emulator). A new dependency needs justification.

## Extensions (not plugins — read this before adding UI features)

Frontend features are **plain React code** living in `ui-extensions/<name>/`,
auto-discovered by `ui-extensions/index.ts` (drop the folder, that's the
install). They register against a small vocabulary of **kinds**:

| Kind | What it does | Surfaces via |
| --- | --- | --- |
| `region` | renders into any `<Slot region="…">` marker in core markup | generated table: `bun run regions` |
| `command` | palette action (`Extension commands` group) — add `keybind:"ctrl+shift+k"` for global hotkey | palette (⌘/ctrl-K) + keybind |
| `slash` | UI-only slash entry for Composer `/name` | Composer `/` autocomplete |
| `message` | full replacement for any message type — first non-null wins | `MessageItem` per message |
| `message.decoration` | per-message extras | under every message row |
| `message.part` | inject after each text/tool/reasoning part | inside `MessageItem` per part |
| `tool.renderer` | custom card for a specific tool name | `ToolCard` per tool |
| `contextMenu` | right-click item `target:"message"\|"session"\|"file"` | context menu |
| `hook` | intercept `session.prompt`, `message.render`, `store.dispatch` — `event:string` open so new seams need no registry bump | store + `MessageItem` + `Composer` |
| `page` | full surface at auto-route `/ext/{id}` | sidebar links + direct URL |
| `settings` | titled section inside Settings › Extensions | Settings dialog |
| toasts | `window.__opencodeUI.notify({title, variant})` | bottom-right stack, 3s |

- **Add a feature**: create `ui-extensions/<name>/index.tsx`, call
  `register({ kind, ... })`, export its `id`, keep the trailing
  `import.meta.hot.accept()` line. Adding, editing, and deleting extension
  folders are all hot (no reload).
- **Disable**: remove its id from the `enabled` list in
  `ui-extensions/config.ts`.
- **Full app access**: extensions are the same build — they can use
  `useStore`, `api`, and any component.
- **The kinds + region list is the contract** (`src/extensions/registry.tsx`
  owns it). Adding a REGION MARKER is a one-line, always-welcome change.
  Adding a new KIND is a deliberate contract change: edit registry.tsx +
  document here and in `ui-extensions/README.md`. Never build speculative
  kinds.

## Commands

- `bun run dev` — proxy + Vite with HMR
- `bun run preview` — second dev instance on 5174/4098 for reviewing WIP edits
- `bun run typecheck` — `tsc --noEmit`
- `bun run build && bun start` — production build, served on 4097
- `scripts/uitest/*` — reusable UI/service checks (create/send/wait/messages,
  event-capture, catch-up proof, extension contract check).

## Live streaming (robustness model)

The service emits one assistant message per step and often no
`session.execution.*` events, so the store treats step events as the run
lifecycle and keeps an ordered live projection:

- **Proxy-side event recorder** (`server/index.ts`): the proxy keeps one
  always-on service-side subscription and a bounded per-session ring
  buffer. The engine serves no mid-stream text over REST and does not
  replay a fresh `/api/event` subscription — a browser that attaches,
  reloads or reconnects mid-run pulls the gap from
  `GET /api/webui/replay?sessionID=X` (`fetchReplay`, on session adopt +
  SSE reconnect) and feeds it through the normal event path, with id-based
  dedupe and overlap-safe delta appends. `bun run check:swap` tracks
  whether the engine's durable per-session log can replace the recorder.
- **`store.queued`**: set optimistically on send and
  `session.inbox.enqueued`; cleared on the first live event. Covers the
  provider cold-start gap and messages queued behind an active run.
- **Ordered live parts**: each live assistant keeps text/reasoning parts by
  event ordinal and tools by call ID, in event order.
- **Frame-batched events**: SSE events are reduced in 16ms batches so a
  token burst produces one React update.
- **SSE watchdog** (`events.ts`): no bytes for 20s → reconnect; byte-age
  (`sseStale()`) feeds the scheduler's tier decision. Proxy sockets set
  `idleTimeout: 0` in `Bun.serve` — liveness is owned by heartbeats
  (~15s), the browser fuse, and `req.signal` aborts.
- **Fetch scheduler** (`src/lib/scheduler.ts`): the ONLY owner of recurring
  timers. One 1s loop picks a tier — LIVE ~2s, IDLE ~12s, HIDDEN ~60s —
  and runs registered pollers with jitter and in-flight guards.
  Components never own `setInterval`.
- **Poll fallback** (`store.pollOnce`): on the LIVE tier, running/queued/
  pending sessions' messages are fetched and reconciled; optimistic
  `msg_local_` copies are dropped once the real message exists; sessions
  whose fetches keep failing are retired so a deleted session can't 404
  forever.
- **`session.wait` long-poll** (`ensureSessionWait`): one loop per running
  session; 204 with a still-set running flag means the terminal event was
  missed (dead SSE) — clear the flag, settle history.
- **`settleLiveMessages` / `adoptPendingAssistant`**: on run end, reload
  history (retry once if not yet persisted); `step.started` re-keys the
  "pending" placeholder to the real assistant id.

## Rendering (live vs history)

- `Conversation` renders all live assistants in ONE growing block, ALWAYS
  below the entire persisted transcript.
- **Ghost live GC**: a live assistant that never persisted and whose
  session is idle is retired after ~30s.
- Consecutive assistant messages render compact (header only on the first
  of a group); empty text parts are skipped.
- **`liveToolPart`** builds the exact `ToolPart`/`ToolState` shape so
  `ToolCard` never crashes on a missing state.
- **Staged-revert view**: with `session.revert.messageID` set, the
  transcript is cut at that message (`applyRevertView`); `/redo` steps
  forward or clears.

## Tool cards (v2 TUI style)

Tools render as ONE inline row (icon + label, muted when done, spinner
while running, red + expandable on failure). Rich results get a titled
block: `edit` shows per-file diffs via DiffView, `write` shows the file
with line numbers, `shell` shows command + output (collapsed past 10
lines), `subagent` links to the child session, `execute` lists its tool
calls. With tool details OFF, completed tools hide entirely (TUI parity).
Extension renderers win via `getToolRenderer`.

## Arrow keys & prompt history (v2 TUI bindings)

- Composer focused: ↑/↓ walk prompt history only from buffer start/end
  (`src/lib/promptHistory.ts`); ↓ at the end (or on empty input) opens the
  RunsPanel. Left/right always move the caret.
- Composer unfocused: ↑ parent session, ←/→ cycle subagent siblings (wrap),
  ↓ opens the RunsPanel.
- **RunsPanel** (`src/components/RunsPanel.tsx`): the bottom
  subagents/shells strip that REPLACES the composer while open
  (`store.runsPanelOpen`; not a modal). Tabs switch Subagents ↔ Shell,
  ↓/↑ move the selection, Enter opens, ↑ at the top or Esc closes and
  returns focus to the composer.
- **Subagent pages open read-only** (`store.subagentComposerOpen`): the
  composer is replaced by a sibling-chip strip; Enter reveals the composer,
  Backspace (empty buffer) returns to the parent.
- **Type-anywhere → composer** (`src/lib/composerHandoff.ts`): a printable
  key pressed on a non-editable surface focuses the composer and lands the
  character. Skipped while overlays are up and for ctrl/meta/alt combos.
- Modifier-free combos never fire while typing (`useHotkeys` skips
  editable targets). The tab title mirrors the open session with a `●`
  prefix while it runs.

## Debug logging

The frontend logs (`[boot] [sse] [evt] [run] [session] [send] [poll]`)
POST to the proxy's `/api/debug` sink, which appends to `$WEBUI_DEBUG_LOG`
(default `/tmp/webui-debug.log`). Server/proxy logs go to stdout when
`WEBUI_DEBUG=1`. Console mirror: set `localStorage.webui.debug = "1"` and
reload.
