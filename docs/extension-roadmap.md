# Extension system roadmap — the next seams

> **Status:** proposal, not a spec. This doc says *why* and *what*; the agent
> implementing an item owns *how*, within the rules below. If a design here
> conflicts with the extension-system spec, the spec wins and this doc gets
> updated.

## Why this exists

We can't predict every extension a user will want. So we don't try. Instead we
make sure each **axis** of extension behavior has one general, durable seam. A
feature request that feels impossible almost always means one axis is thin —
and the fix is to widen that axis, not to add a one-off hook or push the feature
into core.

The job of this roadmap is to close the known axis gaps, and to give the next
implementer a shared vocabulary so the same gap doesn't get "solved" twice.

## The axes

| Axis | What the extension asks | Today |
| --- | --- | --- |
| **Observe** | "tell me when / what happened" | thin — no event subscription |
| **Place** | "put this somewhere" | partial — a fixed target inventory |
| **Transform** | "change what core renders / does" | strong — wrap / replace / service |
| **Act** | "call the engine / change state" | strong, but the store is uncurated |
| **Persist + configure** | "remember this / expose a setting" | partial — `kv` yes, settings no |
| **Schedule** | "do this on a cadence" | missing — the scheduler isn't exposed |
| **Compose** | "cooperate with other extensions" | missing — no collections / bus |

The proxy stratum is already well covered (`routes` / `middleware` / `onEvent` /
`pollers` / KV). Nearly every gap is browser-stratum data, placement, or timing.

## The test to apply to every future request

> Can a plausible extension be built **without** (a) editing core, (b) the DOM
> stratum, (c) owning raw timers, and (d) importing `src/` internals?

If any answer is "no", that points at a missing seam. Prove it by building one
real extension through the public bridge alone; the friction you feel is the
roadmap. Keep a small cookbook of probes (notify on finish, sound cue, cost
meter, custom tool renderer, prompt transformer, settings page, auto-approve,
TTS, timeline, theme swap) and re-run it as seams land.

## Rules for any change here

- **Widen an axis** (new event name, new slot id, new collection) over adding a
  new kind. A new kind is a deliberate contract change.
- **One method per concern.** No second registry, gate, loader, or fallback.
- **Contracts are versioned.** Target/slot/service/collection ids and the
  extension API surface are contract: rename or move = version bump + migration
  note, in the same commit.
- **Stale-proof by default.** Prefer seams that keep working as core evolves
  (flow-through wraps, consulted services) over frozen snapshots.
- **Crash-isolated and hot-swap-safe.** A broken extension must never break the
  core path; edits must swap in place without ghosts or doubled effects.
- **Docs move with the code:** authoring guide, this roadmap, and the webui
  skill in the same commit.

---

## The changes

### 1. Wraps can transform the props they delegate
**Why.** A wrap can render *around* a target but not *feed* it changed props, so
"append one value to a list prop" or "add a class / override a handler" forces a
sibling hack or a full `replace` (which freezes the core implementation). This is
the smallest change with the largest reach.
**What.** Let the wrap's delegate accept optional prop overrides that merge over
the current props for the rest of the chain; with none supplied, behavior is
exactly as today.
**Acceptance.** A wrap can add a value to a list prop and have core render it,
while still composing with other wraps and staying stale-proof.

### 2. The scheduler is available to extensions
**Why.** Timed extensions currently roll their own `setInterval`, which violates
"the scheduler owns recurring timers" and ignores the live/idle/hidden tiers.
**What.** Expose poller registration (and a one-shot delay) through the extension
surface, with tier awareness. Extensions register; core owns the clock.
**Acceptance.** The TPS-style meter, a keep-alive, and a "poll an external API"
extension can all be written with no component-owned timers.

### 3. An event subscription service
**Why.** The extension wanting "tell me when a token/tool/run changed" must
currently diff whole-store snapshots off a firehose. That's the single biggest
missing axis: every live metric, notification, sound, auto-scroll, automation,
and analytics extension needs it. The event stream already exists; we just don't
hand it out.
**What.** A subscription over the engine/store event stream by event name (plus
a wildcard), with the documented payload shapes, and a stable set of **browser
lifecycle events** (run started/ended, tool called/completed, permission asked,
message appended, session idle). Mutation, when offered, must be explicit and
ordered.
**Acceptance.** A tokens/sec meter, an "on finish, notify" rule, and a tool-usage
logger are each implementable without touching the store or diffing state.

### 4. A curated store facade + imperative subscribe
**Why.** The bridge hands extensions the entire store module, so internals *are*
the de-facto API and any refactor is a silent break. Non-React extensions also
have no way to observe state at all.
**What.** A documented set of selectors and actions (the supported surface) plus
a non-React subscribe; keep the raw module reachable but explicitly *advanced /
unsupported*. New internals should not become new API by accident.
**Acceptance.** The common extension needs (read sessions/messages/live state,
send a prompt, navigate) are covered by the documented surface, and that surface
can evolve without reading the whole store.

### 5. Per-extension settings
**Why.** `prefs` is a closed shape, so "add a feature with a toggle / threshold /
format option" means every extension rebuilds a settings UI and its own storage.
**What.** A declared settings schema with defaults; core renders it in
Settings › Extensions and persists / migrates it. The manifest or the extension
entry can declare it; the extension just reads resolved values.
**Acceptance.** Adding a persisted, user-visible option takes a declaration, not
a bespoke component.

### 6. Generic slots for arbitrary placement
**Why.** If a user wants UI in a spot we didn't pre-register, they reach for the
fragile DOM stratum or we add a target per location. Targets are for *semantic*
units; placement needs a general answer.
**What.** Named insertion points stamped at meaningful boundaries, addressable
via `contribute`, with a registry of slot ids. Targets stay for units with
identity (timestamp, tool card); slots handle "insert here".
**Acceptance.** New UI can be added in common chrome (header actions, above the
composer, message gutter) without a new core target and without DOM hacks.

### 7. An explicit extension lifecycle
**Why.** A browser entry is a side-effecting module. Extensions that add listeners
or timers outside React survive HMR with `window.__*Installed` guards — a smell
that also leaks on disable.
**What.** An activation entry that receives a context (register, disposal, the
services above, logging) and returns / registers teardown. Deprecate the ambient
side-effect shape over time.
**Acceptance.** Hot-swap, disable, and delete tear down cleanly with no manual
guards; non-React extensions have somewhere to hook their cleanup.

### 8. The manifest as a checkable contract
**Why.** A renamed target or missing slot silently renders nothing. "Never break
silently" should be enforced, not aspirational.
**What.** Optional `requires` (API version, targets/slots/services) and declared
capabilities in the manifest; core warns clearly when a reference can't be
satisfied, and the settings UI can show what an extension expects.
**Acceptance.** Pointing an extension at a missing target produces a visible,
actionable warning rather than a blank spot.

### 9. Peer composition
**Why.** The bridge doesn't expose collections or any pub/sub, so extensions are
isolated folders that can't cooperate or build on each other.
**What.** Let extensions enumerate registry-owned collections, and provide a small
extension-to-extension bus for events. `service` already covers provide/consume;
this covers many-to-many.
**Acceptance.** One extension can render another's contributed items and react to
its events without either importing the other.

### 10. Later / as demand appears
A developer inspector (what's registered, which targets are wrapped, hook fire
counts, errors, bundle sizes); a secrets service for integrations; a theme
service with change notification; access to the replay/event log for timelines;
hook ordering/priority; i18n. None are urgent; all are predictable. Do them when
a real extension needs them, not speculatively.

---

## Non-goals

- **No sandboxing.** Dropping a folder is an act of trust, same as host plugins.
- **Don't absorb extension features into core.** Core stays minimal; we dogfood
  the public surface or it rots.
- **Don't invent a second way to do something that exists.** Prefer the existing
  axis.
- **Don't break existing ids.** Additive changes (new optional props, events,
  slots, collections) are preferred; renames/moves require a version bump and a
  migration note.

## Suggested sequencing

1. Prop-transforming wraps (small, immediate).
2. Scheduler access (small).
3. Event subscription + lifecycle events (the big unlock).
4. Store facade + imperative subscribe.
5. Per-extension settings.
6. Slots.
7. Lifecycle entry, then manifest `requires` + diagnostics.
8. Peer composition, inspector, secrets, theme as demand appears.

Each lands with its docs and, where it touches the contract, a version bump.

## Where to look

- `src/extensions/registry.tsx` — the five kinds, targets, collections, services.
- `src/extensions/hooks.ts` — the open hook-event runner.
- `src/lib/extensionApi.ts` — the bridged surface and `EXT_API_VERSION`.
- `src/lib/scheduler.ts` — the single timer owner.
- `src/store.ts` — state, actions, the event reducer.
- `src/lib/domKit.ts` — the DOM stratum kit and `data-oc-*` anchors.
- `webui-extensions/README.md` — the authoring guide (update with every seam).
- `docs/extension-system-spec.md` — the contract; this doc is subordinate to it.

---

## Implementation progress

Landed in order (adjusted sequencing: the lifecycle/context lands before the
seams it hosts). One contract bump + docs/skill/battery sweep at the end.

- [x] **1. Prop-transforming wraps** — `next(overrides?)` shallow-merges into the
  remaining wraps + leaf; no-arg behavior unchanged. Battery: `wrap transforms
  props (next overrides merge down-chain)`.
- [x] **7. Lifecycle entry + context** — moved up; the host for 2/3/4/5.
  `src/extensions/context.ts` (`activate(ctx)` → register/onDispose/log/
  services); both loaders call `activateExtension` and dispose on
  swap/disable/delete. Battery: `activation context: register + dispose +
  teardown`. Ambient module-scope registration still works (deprecating).
- [x] **2. Scheduler access** — as context methods (`poll`/`after`); tier-aware
  recurring pollers via the shared scheduler, one-shot delays auto-cleared.
  Battery: `context scheduler: poll + after, disposed on teardown`.
- [x] **3. Event subscription** — `src/lib/eventBus.ts`: raw engine events by
  `type` + derived `run.started/ended`, `tool.called/completed`,
  `message.appended`; `"*"` wildcard; frame-batched, crash-isolated.
  `ctx.on` / bridge `events.subscribe`, disposed with the extension.
  Battery: `event bus: …` + `store event integration: raw + derived (tool/run)`.
- [x] **4. Curated store facade + imperative subscribe** —
  `src/lib/storeFacade.ts`: the supported selectors/actions + non-React
  `subscribe`/`select`; bridge `store` is the facade, raw module is
  `advanced.store` (unsupported). `ctx.store` / `ctx.subscribe` (auto-disposed).
  Battery: `store facade: immediate + change-gated subscribe + ctx disposal`.
- [x] **5. Per-extension settings** — manifest-declared schema; core renders it
  in Settings › Extensions and persists per id (`src/lib/extSettings.ts`).
  Extensions read via `ctx.settings` / bridge `settings.forExt(id)`. Battery:
  `manifest contract: …` + `extension settings: …`.
- [x] **8. Manifest `requires` + capability diagnostics** —
  `src/extensions/manifest.ts` parses/validates; the loader checks
  targets/slots/services/api each sync and records
  `src/lib/extensionDiagnostics.ts` warnings shown on the card (+ console).
  `data-oc-*` / slot ids feed the slot check. Battery:
  `extension diagnostics + known slots`.
- [x] **6. Slots** — thin: `contribute` on `slot:<id>` rendered by
  `src/extensions/slots.tsx` (`SLOT_IDS`, `data-oc-slot`); no new kind.
  Battery: `slots: contributions render in order + unregister cleanly`.
- [ ] **9/10. Peer composition, inspector, secrets, theme** — as demand appears.
