# TIMER / LIVENESS REWORK — HANDOFF

> Standalone doc for ONE problem: the web UI's polling/timer sprawl, the SSE
> flakiness that caused it, and everything that is "not instant when it should
> be". Written for a fresh session with zero prior context. Nothing else in
> the repo needs to be read first (AGENTS.md/HANDOFF.md hold general
> architecture and are useful but not required for this).
>
> Status when written: the *correctness* layer is solid and recently hardened
> (late-join catch-up via the proxy recorder works, run-state watchdogs exist,
> revert/edit flow is event-driven). What's left is the **fetch scheduling
> mess** and the **unverified connection-lifecycle flake**. Both are scoped
> below with a work plan. No implementation has started on the rework.

---

## 1. Symptoms (what the user actually sees)

1. **Site left idle for a long time visibly "refreshes" every few seconds** —
   sidebar/list churn, periodic network bursts, for no user-visible reason.
2. **idle → active is not instant.** A run starts (the TUI shows it
   immediately) but the web UI's active dot / composer status / transcript
   pick it up seconds later, in a way that feels like polling, not push.
3. **The UI gets laggy over long/heavy sessions** (high streaming throughput
   makes it worse).
4. *(Historical, mitigated but relevant context)* **Stream appeared 5–15s
   late** when a run started while the tab was reloading/reconnecting — the
   browser missed the head of the stream and had no way to catch up until the
   proxy-side event recorder was added (see §5, already implemented).

## 2. TL;DR diagnosis

- The **event push channel (SSE) is treated as unreliable**, so over time
  nearly every correctness concern got its own REST safety-net poll. Nobody
  ever removed one, and they share no scheduler, no backoff, and no
  visibility awareness. Result: ~8 overlapping channels, unconditional
  sweeps every ~10s even when idle, N+1 loops, and reconnect bursts that
  fire *more* sweeps.
- The push channel is *actually* somewhat flaky in dev, and the #1 suspect
  is **connection lifecycle** (idle reaping in the dev proxy chain vs 15s
  engine heartbeats), not the SSE protocol itself. UNVERIFIED — see §6.
- The engine has hard limitations the client must live with (all verified,
  §4): no mid-stream text over REST, no event replay for a fresh
  subscription, laggy `/session/active` + inbox listings. These are exactly
  why the polls exist — so the rework must consolidate them, not naively
  delete them.

## 3. Complete timer / poll inventory

Line numbers drift — the anchor text is what to grep for.

### Global (start at boot, run forever, even when idle)

| Where | Cadence | What it does | Why it exists | Verdict |
|---|---|---|---|---|
| `src/store.ts` — `startPolling` / `POLL_MS` (grep `POLL_MS = 2000`) | **2s** | `pollOnce()`: fetches `GET /session/{id}/message?limit=50` for a target set (running sessions, sessions with pending inbox rows, mounted panes with live/queued content, sessions holding live entries) + `reconcileInbox` for those with pending rows or queued flags | "A finished answer can never be lost" — messages fetch is the fallback for silent SSE. Target set is EMPTY when idle → early return, zero fetches | **KEEP** as the adaptive poll's fast tier |
| `src/store.ts` — same tick calls `refreshQueues()` on ticks 1–2 and every 5th (**10s**) | **10s** | permissions + global forms + per-mounted-session forms **+ one `GET /form/{id}/state` per known form id (N+1!)** | A missed `form.created`/`permission.asked` SSE event must never leave an agent blocked unnoticed | **KEEP but fix N+1 and make conditional** (§8) |
| `src/store.ts` — same tick calls `refreshSessions()` every 5th (**10s**) — *added recently (watchdog)* | **10s** | `GET /session?limit=100+` + `GET /session/active`; also the run-state watchdog that clears stuck `running`/`queued` flags when the engine says idle (constants: `RUNNING_WATCHDOG_MS`/`QUEUED_WATCHDOG_MS`, grep `ACTIVE_READD_SUPPRESS_MS`) | Engine-active map is the only cross-tab/engine-side liveness signal; watchdog fixes stuck flags | **KEEP the watchdog, but see §8** — the unconditional sweep is heavy (100+ session list every 10s, replaces the array → sidebar re-render) |
| `src/store.ts` — `debouncedRefreshSessions` | 400ms debounce | refreshSessions on many event types | event-driven coalescing | fine |
| `src/api/events.ts` — `STALL_TIMEOUT_MS = 20_000` | 20s fuse | SSE reconnect when no bytes (heartbeats should arrive every ~15s) | half-open connections | see §6 — fuse length tied to heartbeat reality |
| `src/api/events.ts` — reconnect loop | 1.5s (0.5s after stall) | reconnect forever | — | add backoff? low priority |
| `server/index.ts` — event recorder | own SSE + 1.5s backoff | always-on service-side subscription → per-session ring buffer → `GET /api/webui/replay` | late-join/reload catch-up (engine has no replay) | **KEEP** (recently added; proven by `scripts/uitest/catchup-check.ts`) |
| `src/store.ts` — `enqueueEvent` flush | 16ms | frame-batch SSE bursts into one render | perf | fine |
| `src/store.ts` — `scheduleQueueDrain` | 1.8s per run end | failsafe: flip head parked queue item to steer if the engine never delivers it | queue progression | fine |
| `src/store.ts` — `settleLiveMessages` retry | 1.5s once | history re-fetch if live assistants hadn't persisted at run end | settle race | fine |
| `src/store.ts` — `INTERRUPT_ARM_MS` | 2.5s | Esc confirm hint self-revert | UX | fine |
| `src/lib/log.ts` flush | batched | POST debug lines to `/api/debug` | logging | fine |

### Component-level (only while mounted — but that's the whole app for some)

| Where | Cadence | What | Verdict |
|---|---|---|---|
| `src/components/ActivityStrip.tsx` (grep `setTick`) | **1s** ×2 | strip re-render tick (runs **even when the strip renders null** — I added it for signal-age expiry) + per-running-row elapsed timer | merge into one tick **gated on `hasActive`** |
| `src/components/Composer.tsx` (grep `void load(), 5000`) | **5s** | shells/PTY catalog for the runs chips | subscribe to scheduler slow tier |
| `src/components/RunsPanel.tsx` | 5s | shells list (while open) | same |
| `src/components/InboxPanel.tsx` | 5s | inbox list (while open) | same |
| `src/components/ShellPanel.tsx` | 5s + **1.2s** | shell list + live output append (while open) | output poll is legit (PTY writes); list can be slow tier |
| `src/components/settings/SettingsDialog.tsx` | 10s | provider/settings list (while open) | slow tier |
| `src/components/settings/IntegrationsSection.tsx` | 2s | integrations status (while open) | medium tier |
| `src/lib/runtimeExtensions.ts` (grep `POLL_MS = 8_000`) | **8s** | plugin UI bridge probe (documented "while visible") | slow tier |
| `src/components/RunNotices.tsx` | 15s + one more | notice aging / re-render | fine, rare |
| `src/components/Conversation.tsx`, `Sidebar.tsx`, `FilePicker.tsx`, `settings/shared.tsx`, `src/lib/notify.ts` | one-shot setTimeouts | highlight ring (2s), copy-reset, toasts (3s), scroll retry | fine, leave alone |

### What this means in practice

Per ~10 seconds while **completely idle**, the app does at minimum:
`GET /session (100+ items)` + `GET /session/active` + `GET /permission/request`
+ `GET /form/request` + `GET /session/{id}/form` ×mounted + `GET /form/{id}/state`
×known-forms + extensions probe + Composer's `GET /shell` + `GET /pty` —
and every sweep **replaces the sessions array** → Sidebar re-render. That is
the visible "refresh every few seconds". If the SSE connection is ALSO being
idle-killed (see §6), every reconnect fires `onOpen` →
`refreshSessions` + `refreshQueues` + replay pulls → the burst doubles.

## 4. Verified engine facts (probes exist; do not re-litigate)

All verified against the live service (engine `0.0.0.0-beta-18684`):

1. **Heartbeats exist and arrive every ~15s** as `: heartbeat` comment lines
   on `/api/event`. Verified with `timeout 40 curl -sN localhost:4097/api/event`.
2. **NO mid-stream text over REST.** `GET /session/{id}/message` and
   `GET /session/{id}/message/{id}` both serve part skeletons with `text:0`
   until each part ends (probe: `scripts/uitest/probe-midrun2.ts`). The
   122-char reasoning part seen on an unfinished message was a COMPLETED part
   of a finished step.
3. **A FRESH `/api/event` subscription receives only future events** — no
   history replay (measured, note on `appendStreamDelta` in `src/store.ts`).
   Hence the proxy recorder + `fetchReplay` catch-up (already built, proven
   by `scripts/uitest/catchup-check.ts`: a store attaching 6s late
   reconstructs 380+ chars of stream).
4. **The engine's `/session/active` map lags tens of seconds** after a run
   ends, and the **inbox listing lags delivery** by tens of seconds
   (`scripts/uitest/probe-bugfix.ts`, probe-steer session). Never trust them
   for REMOVAL without a freshness guard (that's what the watchdog constants
   in `refreshSessions` are for).
5. **A delivered inbox item's id === the persisted user message id** — the
   transcript is a more truthful "delivered" signal than the listing
   (`reconcileInbox(sessionID, history)` in `src/store.ts`).
6. **This deployment emits one assistant message per step and often NO
   `session.execution.*` terminal events** — the reducer treats
   `step.started` / `step.ended(finish=stop)` as the run lifecycle, with
   `execution.*`/`session.status`/`session.idle` as canonical when present
   (grep `seenExecution` in `src/store.ts`).

## 5. What the flake actually was (evidence)

Frontend log `/tmp/webui-debug.log` (grep `\[sse\]`), server log
`/tmp/webui-server.log` (needs `WEBUI_DEBUG=1` — `scripts/start-dev.sh` sets it):

- **STALLED cycles**: `STALLED - no data for 30s; forcing reconnect` repeating
  at exactly the fuse interval → the browser received **zero bytes, not even
  heartbeats**, for entire windows. Either the tab was background-frozen
  (Chrome throttling) or some hop eats idle connections. Direct curl at the
  proxy DOES receive heartbeats — so the suspect hops are vite's proxy and
  Bun's server idle handling (§6).
- **2s 404 loop** (seen in the server log): a probe session was deleted
  mid-run; the browser had already processed its `execution.started`
  (sets `running[sid]=true` unconditionally) and created a live entry; no
  terminal event ever arrived; the 2s poll then fetched messages for the
  dead session every 2s → 404 forever. The watchdog *should* clear the
  running flag (15s after last signal), but the **live entry never retires
  on repeated fetch failure** — `applyFetchedMessages` only retires on
  SUCCESSFUL fetch. That's a real bug (§8, fix 1).

## 6. Prime suspect (UNVERIFIED): idle connection reaping

**Theory**: something in browser → vite(5173) → proxy(4097) → service reaps
SSE connections that are silent longer than N seconds, where N < 15s heartbeat
interval — producing perpetual reconnect churn while idle, each reconnect
triggering the onOpen sweep burst. Bun's `server.serve` has a default
`idleTimeout` (historically 10s) — if it applies to the passthrough despite
15s heartbeats, that alone explains everything. Direct curl to 4097 survived
40s with 15s gaps, so if it's Bun, the vite hop or a version detail is the
difference.

**How to verify (do this FIRST in the rework session):**
1. `scripts/start-dev.sh`, open the app, leave it IDLE and visible, then
   `tail -f /tmp/webui-debug.log` and count `[sse] connected` lines per
   minute. Healthy = ~0 while idle.
2. Compare heartbeat reception through each hop: `curl -sN localhost:5173/api/event`
   (through vite) vs `curl -sN localhost:4097/api/event` (direct) — time the
   `: heartbeat` lines for 60s each.
3. If reaping confirmed: set `idleTimeout` explicitly on `Bun.serve` in
   `server/index.ts` (e.g. `idleTimeout: 120`), and check
   `vite.config.ts` server.proxy options (`timeout`, `proxy.timeout`). Re-test.
4. Consider the proxy injecting its own `: ping` comment every 5–10s into the
   browser-facing stream (wrap the passthrough body in a TransformStream) —
   then the 20s fuse becomes reliable in dev AND prod.

## 7. Why idle → active is delayed (the staircase)

With healthy SSE it IS instant: `session.execution.started` sets
`running[sid]` unconditionally → dot/status immediately. The staircase
appears when the connection was dead at run start:

- detection falls back to REST: sessions/active sweep every **10s** (running
  flag), messages poll every **2s** (content — but only for sessions already
  flagged running/queued/pending/live), queues every **10s**;
- on reconnect, `onOpen` now also pulls replays for mounted/running sessions
  (catch-up), but that only happens at the NEXT reconnect;
- background tabs: Chrome throttles timers (≤1/min after ~5min hidden) —
  everything above slows dramatically and paints late on refocus.

Fixing §6 + the scheduler (§9) fixes this end-to-end. Additionally: the
engine's active map lags (§4.4), so even REST detection can lag the truth —
the client can't beat that, only shorten its own polling tier.

## 8. Concrete bugs found during investigation (fix alongside the rework)

1. **Stuck live entry / stuck running flag on vanished sessions** → 2s 404
   churn forever (§5). Fix: in `applyFetchedMessages` / `pollOnce`, retire a
   session's live entries and clear its `running`/`queued` after N consecutive
   message-fetch failures (404 ⇒ immediately). Must also prune
   `lastReplayID` and the recorder buffer is TTL'd already (10min).
2. **`refreshSessions` replaces the whole sessions array every sweep** even
   when nothing changed → Sidebar re-render every 10s. Add
   compare-before-set (shallow id+time.updated comparison) like
   `samePendingList` does.
3. **`refreshQueues` N+1**: one `GET /form/{id}/state` per known form id
   every 10s. Batch it (engine permitting) or only `/state` forms that are
   mounted/newborn; the listing union logic in `refreshQueues` documents why
   it exists — read it before touching.
4. **`fetchReplay` on EVERY reconnect** even when nothing was missed. Track
   the last processed event id per session (already: `lastReplayID`) and rely
   on `since=` (already implemented server-side) — the pull is cheap only
   when the buffer is trimmed; on reconnect it currently re-pulls the tail
   every time. Consider pulling only when the SSE connection dropped for
   >1s or a gap is detected (event id discontinuity).
5. **Recorder does `JSON.stringify` twice per recorded event** (bytes
   accounting) and re-stringifies every dropped event in the ring-cap loop —
   compute the length once, store it on the entry.
6. **ActivityStrip 1s tick runs even when the strip renders null** — gate the
   interval on `hasActive`.
7. **`pollOnce` includes sessions with live entries (recent addition)** —
   correct for retirement, but combined with bug 1 it polls dead sessions.
   Bug 1's fix covers it.

## 9. Target design: one scheduler

New module `src/lib/scheduler.ts` (name it anything) — the ONLY place that
owns timers (besides one-shot UX timeouts and the SSE stall fuse):

```
tiers (evaluated every tick, jitter ±10%):
  LIVE    2s     — any session running/queued/pending/live, or SSE unhealthy
  IDLE    12s    — nothing streaming
  HIDDEN  60s    — document.hidden (visibilitychange listener)
channels (registered consumers, each with a min-interval and a "dirty" check):
  messages(sid)   — per mounted/running session; skips sessions clean since last fetch
  sessions/active — the sweep + watchdog
  queues          — permissions/forms (fix N+1 first)
  shells/pty      — composer chips / panels (subscribes instead of own setInterval)
health signal:
  SSE connected + last byte age < 2×heartbeat interval (15s measured)
    → push channel trusted: skip REST sweeps entirely except the watchdog cadence
    → on first byte-gap or reconnect: run one catch-up pass (replay + sweep), then back off
```

Rules:
- Components stop owning `setInterval`; they register with the scheduler or
  derive from store state. (The store remains the only state owner — AGENTS.md
  rule 2 still holds.)
- Everything stays compatible with the existing reducer; this is a
  scheduling layer change, not a state-model change.
- The recorder + `fetchReplay` stay exactly as they are (they're the
  correctness backstop for the push channel's gaps).

## 10. Work plan (ordered, each step independently shippable)

1. **Verify/fix connection reaping** (§6). Acceptance: 10 min idle, visible
   tab → zero `[sse] connected` lines in the debug log.
2. **Fix bug list §8.1** (stuck 404 churn). Acceptance: delete a session
   mid-run → within one poll tick the 404s stop; no console errors.
3. **Build the scheduler** (§9), migrate `pollOnce`/`refreshQueues`/
   `refreshSessions` into it. Acceptance: idle visible tab → network
   activity ≤1 burst/12s; live tab during a run → 2s message tier only, no
   10s sweeps while SSE healthy.
4. **Migrate component intervals** (Composer, RunsPanel, InboxPanel,
   ShellPanel, Settings, Integrations, runtimeExtensions, ActivityStrip tick).
   Acceptance: `grep -rn "setInterval" src/components src/lib` returns only
   scheduler + one-shot UX timers.
5. **Fix refreshQueues N+1** (§8.3) and sessions-array compare-before-set
   (§8.2). Acceptance: idle tab → no Sidebar re-render (React Profiler).
6. **Replay pull discipline** (§8.4) + recorder stringify fix (§8.5).
7. Full regression: `bun run typecheck && bun scripts/uitest/regress-bugfix.ts`
   (26 assertions) and `bun scripts/uitest/catchup-check.ts` (late-join
   proof) — both must stay green.

## 11. Invariants that must NOT break (why the polls exist)

- A missed SSE event can never leave an agent blocked unnoticed — the
  permission/form/question panel must converge within ~10s worst-case even
  with SSE fully dead.
- QueueStrip rows must resolve even if `session.inbox.delivered` is missed
  (poll reconcile + transcript-id drop are the backstops).
- A finished answer can never be lost (message poll is the settle backstop).
- The run-state watchdog must keep clearing stuck flags when the engine says
  idle (never re-introduce unconditional re-add from the laggy active map —
  `ACTIVE_READD_SUPPRESS_MS` exists because of a real stuck-"Working…" bug).
- Late join must reconstruct the stream (recorder + `fetchReplay` on adopt;
  `catchup-check.ts` is the proof).
- The browser never holds service credentials; everything goes through the
  proxy (AGENTS.md rule).

## 12. Debugging quick reference

- Frontend log: `/tmp/webui-debug.log` (grep `\[sse\] \[poll\] \[run\]
  \[gate\]`); console mirror: `localStorage.webui.debug = "1"` + reload.
- Proxy request log: `/tmp/webui-server.log` (needs `WEBUI_DEBUG=1` —
  `scripts/start-dev.sh` sets it). Restart cleanly by PID
  (`ps aux | grep -E "bun run|vite"`), never `pkill -f`.
- Engine probes (ground truth): `scripts/uitest/probe-events.ts` (all event
  types during a run), `probe-midrun2.ts` (REST text:0 mid-run),
  `probe-bugfix.ts` (steer/revert/active-lag ground truth),
  `catchup-check.ts` (late-join proof), `regress-bugfix.ts` (store
  regression, 26 assertions).
- The opencode service is NEVER restarted for UI work; `bun run --watch`
  restarts the proxy alone on `server/index.ts` edits.
