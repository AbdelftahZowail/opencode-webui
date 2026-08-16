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
| `src/store.ts` | Central state: sessions, messages, live streaming, permission/form queues, event reducer |
| `src/components/` | UI: `Sidebar`, `Conversation`, `MessageItem`, `ToolCard`, `Composer`, `Pickers`, `PermissionModal`, `FormModal`, `ui` (primitives) |
| `src/extensions/registry.tsx` | The slot registry — the stable contract for UI extensions (do not change lightly) |
| `ui-extensions/` | Feature folders; `index.ts` wires them in. Authoring guide: `ui-extensions/README.md` |
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
- Forms arrive via `/api/form/request` and are answered with
  `POST /api/session/{id}/form/{formID}/reply`.
- When the UI sends a prompt it is fire-and-forget: `POST .../prompt` only
  queues the message; the events drive everything rendered.
- **Model pinning**: sessions created with `model:null` let the service pick
  its own default at run time (which may be a rate-limited provider). The
  store's `send*` actions and `newSession()` pin the session to the UI default
  (`resolveDefaultModel` → the primary agent's model) via
  `POST .../model` so what the picker shows is what executes. The pickers
  read the authoritative `GET /api/session/{id}` from the `sessionDetails`
  store slice.
- **Session navigation**: session rows are native `/session/{id}` anchors.
  Unmodified left-clicks switch sessions in place through `pushState`; browser
  back/forward uses `popstate`, and direct session URLs load the conversation.
  Modified clicks and middle-clicks remain native browser actions. The New
  session control is a native `/new-session` anchor; its route creates a session
  and replaces itself with the new session's canonical URL, so opening it in a
  new tab creates the session in that tab.
- **Sidebar behavior**: workspaces are grouped by directory and show the three
  newest sessions by default. Each workspace header independently collapses all
  rows; reopening resets the separate `Show N more…` expansion state. The
  sidebar itself can collapse to a 56px icon rail and resize from 240px to
  480px, with double-click on the divider restoring 288px.

## Rules for editing

1. **Never change the contract layer without the OpenAPI doc.** Before
   touching `src/api/types.ts` or `client.ts`, diff against the running
   service: `opencode2 api get /openapi.json` (this needs the `opencode2`
   CLI; the proxy also forwards `/openapi.json`).
2. **Keep the store as the only place state lives.** Components read via
   `useStore((s) => ...)` and call actions; they never fetch directly except
   for one-shot catalog data (`models`, `agents`, `commands`, `skills`).
3. **Hot reload contract**: editing any file under `src/` applies
   immediately via Vite HMR. Adding a new file may trigger one full reload
   (Vite limitation) — that is expected. Editing `server/index.ts` restarts
   the proxy automatically (`bun run --watch`), which drops the SSE stream;
   it reconnects by itself. Never restart the opencode service for UI work.
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
registered against a small set of **stable slots**:

| Slot | Where | Use for |
| --- | --- | --- |
| `sidebar` | bottom of sidebar | quick actions, workspace info |
| `footer` | bottom of window | status bars, counters |
| `composer.replace` | replaces the input composer | custom prompt UIs |
| `tool.renderer` | custom card for a tool name | pretty tool output |

- **Add a feature**: create the folder, add one import to
  `ui-extensions/index.ts`, call `register({ id, slot, render })` from
  `src/extensions/registry.tsx`. It appears via HMR instantly.
- **Disable**: remove its id from the `enabled` list in
  `ui-extensions/config.ts` (one line, instant, no reload).
- **Remove**: delete the import line (and folder).- **Full app access**: extensions are the same build — they can use
  `useStore`, `api`, and any component. No plugin API to learn.
- **The slot list is the contract.** Adding a slot means editing
  `registry.tsx` + the slot render point in the app + this table + the
  `ui-extensions/README.md` table. Never make a slot for a one-off feature —
  core files stay small so upstream updates stay mergeable and extensions
  riding on slots survive them.
- No plugin framework is intentional: plugins cost type safety, hot reload,
  and freedom, and their benefits (runtime toggles, third-party isolation)
  are not needed for a single-author codebase. Sharing with others = npm
  package + one import line. See `ui-extensions/README.md`.

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
treats the step events as the run lifecycle:

- **`store.queued` ("waiting")**: set optimistically on every send AND on
  `session.inbox.enqueued`; cleared on the first live event
  (`execution.started` / `step.started` / `text.started`). Covers both the
  provider cold-start gap (~15s) and messages queued behind an active run.
- **`running` fallback**: if `execution.started` never arrives, a
  `step.started` for a queued session promotes it to running; the final
  `step.ended` with `finish:"stop"` clears it (`seenExecution` remembers
  sessions with real execution events so they keep the canonical path).
- **SSE watchdog** (`events.ts`): if no bytes arrive for 30s the reader is
  cancelled and the stream reconnects (the service replays recent events).
- **Always-poll fallback** (`store.pollOnce`): every 2s the current session's
  messages are fetched and reconciled — merge persisted messages, prune live
  assistants that are now in history, drop optimistic `msg_local_` copies
  once the real message exists. A finished answer can never be lost.
- **`settleLiveMessages`**: on execution end, reload history; if live
  assistants aren't persisted yet, keep them visible and retry once after
  1.5s.
- **`adoptPendingAssistant`**: `execution.started` has no assistant message
  id; `step.started` re-keys the "pending" placeholder to the real id so no
  duplicate "thinking…" block shows.

## Rendering (live vs history)

- **Merged live block**: `Conversation` merges all live assistants for the
  session into ONE growing block (reasoning + tools + text) so a multi-step
  run streams like a single assistant message.
- **Compact continuation messages**: consecutive assistant messages render
  without the repeated `agent provider/model@variant` header — only the first
  in a group shows it.
- **`liveToolPart`** (store): builds the exact `ToolPart`/`ToolState` shape
  from a live tool (streaming input = raw `inputText`, then parsed) — the
  ToolCard reads `part.state`, never crashes on a missing state.
- Empty text parts (e.g. the `"\n\n"` step stub) are skipped.

## Model pinning & pickers

Sessions created with `model:null` let the service resolve its own default at
run time (which may be a rate-limited provider). The store's `send*` actions
and `newSession()` pin the session to the UI default (`resolveDefaultModel` →
the primary agent's model) via `POST .../model` so what the picker shows is
what executes. The pickers read the authoritative `GET /api/session/{id}`
from the `sessionDetails` store slice.

## Debug logging

The frontend logs (`[boot] [sse] [evt] [gate] [run] [session] [send] [model]
[load] [poll]`) POST to the proxy's `/api/debug` sink, which appends to
`$WEBUI_DEBUG_LOG` (default `/tmp/webui-debug.log`). Server/proxy logs go to
stdout when `WEBUI_DEBUG=1`. Console mirror: set
`localStorage.webui.debug = "1"` and reload. See HANDOFF.md — "Debugging the
streaming path".
