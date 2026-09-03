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
- **Sandbox**: `bun run sandbox` (or `bunx opencode-webui sandbox` / the
  binary's `sandbox` arg) starts a SECOND instance on `127.0.0.1:4099` —
  loopback-only, passwordless (refused on a non-loopback bind), attaches to
  the already-running engine, and loads extensions from an ISOLATED scratch
  dir (`WEBUI_EXTENSION_DIR`, default
  `~/.local/state/opencode-webui/sandbox-extensions/`). In a repo checkout it
  also runs Vite (5175) with HMR — it replaced `bun run preview` as the one
  second-instance mechanism. Iterate extensions there; "shipping" = copying
  the folder into the real extension dir.
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
| `src/extensions/registry.tsx` | The extension registry (v2 contract: kinds, target chains, collections, services, hooks — do not change lightly) |
| `src/extensions/hooks.ts` | Shared `fireHooks` runner for `kind:"hook"` extensions (open event strings) |
| `src/lib/domKit.ts` | DOM-stratum kit (`foreign`/`watch`/`styles`, mount/dispose, `data-oc-*` anchors) |
| `src/lib/runtimeExtensions.ts` | Browser loader client: manifest fetch + SSE push, bundle import, same-id swap |
| `server/ext/` | Proxy-stratum loader + mount points (`routes`, `middleware`, `onEvent`, `pollers`, KV) |
| `server/userExtensions.ts` | Browser-stratum folder discovery: one loader, three sources, manifest gating |
| `webui-extensions/` | Shipped extensions (one folder per extension). Authoring guide: `webui-extensions/README.md` |
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

## Extensions (one folder, four strata — read this before adding UI features)

One extension = **one folder** in one format, loaded by one loader, gated by
one rule. A folder may provide code in up to four *strata*
(full contract: `docs/extension-system-spec.md` §4; authoring guide:
`webui-extensions/README.md`; agent skill: `skills/webui/SKILL.md`):

```
my-extension/
  manifest.json    id, name, version, description, disabled (optional bool)
  index.tsx        browser stratum: register() against the registry
  dom.ts           DOM stratum: post-render DOM changes (the free layer)
  server.ts        proxy stratum: routes / middleware / event tap / pollers
  engine/          optional opencode plugin payload (tools, system-prompt hints)
```

| Stratum | Runs in | Reaches | One method |
|---|---|---|---|
| Browser (registry) | the page | React tree, store, api calls, logic modules | wrap / replace / contribute / hook / service |
| DOM | the page, post-render | any node incl. portals, canvas, iframes | `dom.ts` + the DOM kit (`src/lib/domKit.ts`) |
| Proxy | the proxy process | fs, spawn, engine creds, always-on event stream, all clients | `server.ts` + mount points (`server/ext/`) |
| Engine | the engine process | tools the model calls, system prompt | opencode plugin rules (out of scope — we carry the payload, see `docs/engine-payload-convention.md`) |

**Gating — one state, owned by the folder itself:** presence = installed;
manifest `disabled: true` = paused; delete/move the folder to uninstall. No
`config.ts` list, no per-browser localStorage gating, no second registry.

**Loading precedence (same id = same swap point, higher wins):**

1. `~/.config/opencode/webui-extensions/<name>/` — user
2. `<project>/.opencode/webui-extensions/<name>/` — project
3. the app's shipped `webui-extensions/` — ours, updates with the app

A user shadowing a shipped extension = a folder with the same id at higher
precedence. Core updates land underneath; the user's still wins; nothing is
forked. Our own optional features ship as extensions in stratum 3 — we
dogfood the exact same API users get.

The registry has **five kinds, one job each** (`src/extensions/registry.tsx`):
`wrap` (flow-through tweak — the default path for edits, stale-proof by
construction), `replace` (take ownership of one target — the marked escape
hatch, frozen-snapshot semantics), `contribute` (add an item to a named
collection: `palette`, `slash`, `pages`, `settings`,
`contextMenu.message|session|file`, …), `hook` (open event strings —
`api.pre`/`api.post`/`api.error`, `store.dispatch`, `session.prompt`,
`session.adopted`, `pane.focused`, `extension.loaded`, `message.render`, …),
`service` (provide/consume named logic; doubles as value overrides, e.g. the
timestamp formatter). Dropping a folder in the extension dir is an act of
trust (same model as host plugins) — no sandboxing of extension code.

- **Add a feature**: create the folder, write `manifest.json` + `index.tsx`,
  call `register({ kind, ... })`. No repo-file edits, no `enabled` list.
- **Full app access**: shipped extensions are the same build — they can use
  `useStore`, `api`, and any component. External extensions use the one
  extension API surface (`register`, `react`, `api`, `store`, `prefs`,
  `notify`, `services`, `dom` kit, `kv`).
- **Hot reload**: external browser bundles rebuild on edit, bump `?v=`, push
  the manifest over SSE, and the page same-id-swaps with a live repaint
  (sub-second, no refresh). Repo dev uses Vite HMR. Proxy `server.ts`
  modules reload with no proxy restart.

> **How to change the webui without breaking extensibility**
>
> 1. **Every new component must self-register.** Hand-writing an unregistered unit
>    inside a registered one recreates the predicted-seam problem. Use the
>    auto-registration helper; split out leaves for anything plausibly tweakable.
> 2. **Rich props / consulted services over baked-in values.** If a value is
>    format-able, routable, or calculable, it arrives as a prop or a service core
>    consults — never hardcoded inside a unit.
> 3. **Don't add kinds casually.** Kinds are the versioned contract. New seam? Prefer a
>    new `hook` event string (open) or a new `contribute` collection (data). A new kind
>    is a deliberate contract change: registry + docs + version bump together.
> 4. **Target ids, collection ids, service ids, `data-oc-*` anchors, and manifest
>    fields are contract.** Renaming/moving any of them = version bump + migration note
>    in the same commit. Never break silently.
> 5. **Never absorb an extension into core "because it's easier".** Optional features
>    ship as extensions in the shipped source; core stays minimal. We dogfood the
>    public API or it rots.
> 6. **One method per concern.** If you're adding a second way to do something that
>    exists (a second gate, a second loader, a fallback path), stop — you're adding
>    legacy on day one.
> 7. **Proxy changes go through mount points.** New capability in the proxy = a new
>    mount point extensions can use, not core-only logic.
> 8. **Stable markup anchors.** Meaningful markup boundaries carry `data-oc-*`
>    attributes; restyles must not remove them without a contract bump.
> 9. **Docs move with the code.** Every contract-relevant change updates the authoring
>    guide, this rule set, and the skill in the same commit. Code that outruns its docs
>    is a bug.
> 10. **The engine is out of scope.** We carry engine payloads and adapt client-side;
>     we do not reach into engine internals from the webui.

## Commands

- `bun run dev` — proxy + Vite with HMR
- `bun run sandbox` — isolated second instance: loopback-only, passwordless,
  scratch extension dir; dev mode adds Vite on 5175. Replaced `bun run preview`.
- `bun run typecheck` — `tsc --noEmit`
- `bun run build && bun start` — production build, served on 4097
- `scripts/uitest/*` — reusable UI/service checks (create/send/wait/messages,
  event-capture, catch-up proof, extension contract check).
- `bun run scripts/uitest/ext-battery-browser.ts` (+ `-dom`, `-proxy`,
  `-acceptance`) — the extension-system E2E battery, 65 checks total; the
  release gate for anything touching extensions (see Release checklist).

## Release checklist (push + publish — do every step, in order)

Version flows from ONE source: `package.json` (`server` reads it at boot
for `/api/webui/status|config`, `gen:skill` pins the skill to it). Bumping
means editing that one line, then:

1. **Bump** `package.json` version (semver; breaking contract change → major).
2. **Regen** `bun run scripts/gen-skill.ts` — the skill embeds the version +
   `v{version}` tag links; verify the new version appears in
   `skills/webui/SKILL.md`.
3. **Gate** — all green, no exceptions:
   - `bun run typecheck`
   - `bun run build`
   - all four battery files (`ext-battery-browser|dom|proxy|acceptance`)
4. **Commit** with a message describing the contract impact (what breaks,
   what the migration is); keep extension-system + unrelated work in
   separate commits.
5. **Tag** `v{version}` on the release commit (`git tag v2.0.0`).
6. **Push** commit + tag (`git push origin master --tags`). Pushing the tag
   is what makes the skill's pinned `v{version}` raw links resolve.
7. **Publish** `npm publish` (runs `prepublishOnly`: typecheck + gen:skill
   + build). Requires `npm whoami` authed.
8. **Verify** the tag page + npm version + skill links resolve; never publish
   without the tag (skill links would 404).

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
