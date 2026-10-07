# Frontend reference — how the chat UI works

Moved out of `AGENTS.md` (it is reference detail, not law). Every claim here is
about the shipped frontend and its streaming model.

## Chat UI

- History comes from `GET /api/session/{id}/message` (desc, reversed).
- Live output comes from the SSE stream (`/api/event`). The store's
  `handleEvent` reducer builds a "live assistant message" from
  `session.text.*`, `session.reasoning.*`, `session.tool.*`,
  `session.step.*` and `session.execution.*` events, keyed by
  `assistantMessageID`. Tool input arrives as streaming JSON
  (`session.tool.input.delta`) until `input.ended` parses it.
- Permission requests arrive as `permission.asked` events and are answered
  via `POST /api/session/{id}/permission/{requestID}/reply` (`once` | `always`
  | `reject`). The reply **body key** moved upstream (`{reply}` → `{decision}`);
  `replyPermission` sends the current key first and falls back on a 400/422.
- **Pending requests** (`PendingRequestsPanel` + corner chip): permissions,
  questions and forms share ONE FIFO queue in the store. The focused
  session's head request REPLACES the composer slot (RunsPanel idiom, not a
  dialog) until answered; requests from other sessions pop the amber corner
  chip. Queues re-fetch on the poll cadence so a missed SSE event can never
  leave an agent blocked. Mid-task questions arrive as `form.created`
  events with `metadata.kind === "question"`; reply/reject route through
  the form endpoints (multi-select answers as arrays, singles as strings).
- Forms arrive via the global listing (`/api/form` on the current engine;
  `/api/form/request` is the legacy path, tried on 404) and are answered with
  `POST /api/session/{id}/form/{formID}/reply`.
- **Sending while busy**: prompts are fire-and-forget; the events drive
  everything rendered. While the session is BUSY a send becomes a durable
  engine inbox entry rendered by `QueueStrip` — ⚡ steer (next LLM-call
  boundary, Enter) vs ⏳ queue (parked until turn end, Ctrl/Cmd+Enter).
  Rows can be flipped, deleted, or sent now.
- **Model pinning**: `resolveDefaultModel()` resolves a new session's model
  through the model-memory cascade: a user **pin** → **last used** → the
  engine's own default (`GET /api/model/default` — configured `model` when
  available, else newest supported) → the first enabled catalog model. New
  sessions are created WITH that model (`POST /session`); legacy unpinned
  sessions get pinned on first send (`ensureSessionModel`). A committed send
  records the model as last-used/recents, and the pickers expose the pin footer
  + a Recent section (`Pickers.tsx`, `src/lib/modelMemory.ts`). The pickers read
  the authoritative `GET /api/session/{id}` from the `sessionDetails` slice.
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
  Browsers never open their own engine `/api/event` passthrough: every tab
  attaches to the recorder's single engine subscription (N tabs → 1 engine
  subscriber), served with 15s comment heartbeats; when the recorder
  reconnects, attached clients are released so each reconnects and pulls
  replay (id-deduped) for the gap.
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
- **Poll fallback** (`store.pollOnce`): on the LIVE tier, WATCHED sessions'
  messages (mounted panes + focused session) are fetched and reconciled;
  background sessions rebuild on adopt (`loadMessages` + `fetchReplay`) so a
  tab never polls another tab's work; optimistic
  `msg_local_` copies are dropped once the real message exists; sessions
  whose fetches keep failing are retired so a deleted session can't 404
  forever.
- **`session.wait` long-poll** (`ensureSessionWait`): one loop per running
  session THIS tab shows (`isWatched`); 204 with a still-set running flag means
  the terminal event was missed (dead SSE) — clear the flag, settle history.
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
