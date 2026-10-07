# Extension seams — plan of record

> **Status.** Items **1–9 landed** in `EXT_API_VERSION` 2 / release 3.0.0.
> Item **10 is the as-demand bucket**. **E1–E7 are next** (proposal; `E1`–`E7`
> numbering is local to this doc). This doc says *why* and *what*; if a design
> here conflicts with `reference/extension-system-spec.md`, **the spec wins** and
> this doc gets updated. The authoring guide is `webui-extensions/README.md`.

This merges what used to be `extension-roadmap.md` (the landed seams) and
`extension-roadmap-2.md` (the next ones).

## Why this exists

We can't predict every extension a user will want. So we don't try. Instead we
make sure each **axis** of extension behavior has one general, durable seam. A
feature request that feels impossible almost always means one axis is thin — and
the fix is to widen that axis, not to add a one-off hook or push the feature into
core.

The first roadmap gave every axis a seam, and that worked. The remaining problem
is not a missing axis — it is **qualitative**. Three seams are *enumerations*: a
fixed list of slot ids, a fixed list of facade actions, core-owned state with a
fixed set of selectors. An enumeration can only grow when someone foresees a
need, so an extension's reach is capped by lists we maintain by hand — and the
more imaginative the user, the harder they hit the cap.

So the goal is not more features: it is to make each axis **open under
composition**. Curate *shapes*, not features.

## The axes

| Axis | After items 1–9 | What is still closed |
| --- | --- | --- |
| **Observe** | landed — `ctx.on`, raw + derived, `"*"` | the derived vocabulary is thin (few lifecycle events) → **E1** |
| **Place** | partial — fixed `SLOT_IDS` + one page layout | extensions can claim ~5 regions; pages can't choose their layout; nothing can be removed → **E5** |
| **Transform** | strong — wrap / replace / service | nothing needed |
| **Act** | landed — curated facade | curated by *feature*, so reusable capabilities sat on the wrong side of the line → **E4** |
| **Persist + configure** | landed — `settings` + `kv` | state is core-owned; extensions can't own or share any → **E3** |
| **Schedule** | landed — `ctx.poll` / `ctx.after` | nothing needed |
| **Compose** | landed — `collections` + `bus` | nothing to compose *over*: no extension-owned state, and `requires` can't check collections |
| **Discover** *(new)* | half — ids only | targets' props, owners, descriptions are invisible → **E2** |
| **Compute** *(proxy)* | shape is right | no filesystem watch, no spawn helper, untyped engine client → **E6** |

The proxy stratum is already well covered (`routes` / `middleware` / `onEvent` /
`pollers` / KV). Nearly every gap is browser-stratum data, placement, or timing.

## The test to apply to every request

The parent test: **Can a plausible extension be built without (a) editing core,
(b) the DOM stratum, (c) owning raw timers, and (d) importing `src/` internals?**

Add the **closure test**:

> Can an extension occupy every **position**, read every **state**, and call
> every **verb** that the app itself uses?

Core is the existence proof. Whatever shape core uses internally, an extension
must be able to use — so gaps are found by *diffing two vocabularies*, not by
imagining use cases: list the positions core renders, the reads/writes its store
performs, the verbs it exposes to users, and the computations its proxy does;
subtract what extensions can reach. Every difference is a gap by definition.

Prove it by building one real extension through the public bridge alone; the
friction you feel is the roadmap. Keep a small cookbook of probes (notify on
finish, sound cue, cost meter, custom tool renderer, prompt transformer,
settings page, auto-approve, TTS, timeline, theme swap) and re-run it as seams
land. **The probe that motivated the next phase was a source-control panel**
(change list, branch, commit graph, diff review) — it exposed the placement cap,
the state-ownership hole, the internal-only diff reviewer, the thin
discoverability, and the missing proxy watcher in one feature.

## Rules for any change here

- **Widen an axis** (new event name, new slot id, new collection) over adding a
  new kind. A new kind is a deliberate contract change.
- **Curate shapes, not features.** A closed set of *verbs/regions/axes*
  composes into unbounded use cases; a closed set of *features* is permanently
  behind.
- **One method per concern.** No second registry, gate, loader, or fallback.
- **Contracts are versioned.** Target/slot/service/collection ids and the
  extension API surface are contract: rename or move = version bump + migration
  note, in the same commit.
- **Stale-proof by default.** Prefer seams that keep working as core evolves
  (flow-through wraps, consulted services) over frozen snapshots.
- **Crash-isolated and hot-swap-safe.** A broken extension must never break the
  core path; edits must swap in place without ghosts or doubled effects.
- **Names below are working names.** The implementer owns the final shape, and
  the contract bump + migration note lands with it.
- **Docs move with the code:** authoring guide, spec, this plan, and the skill in
  the same commit.

---

## Landed — items 1–9

One contract bump + docs/skill/battery sweep landed at the end. Adjusted
sequencing: the lifecycle/context landed before the seams it hosts.

| # | Seam | Landed as | Battery evidence |
| --- | --- | --- | --- |
| 1 | **Wraps can transform the props they delegate** — a wrap could render *around* a target but not *feed* it changed props | `next(overrides?)` shallow-merges into the remaining wraps + leaf; no-arg behavior unchanged | `wrap transforms props (next overrides merge down-chain)` |
| 7 | **Explicit extension lifecycle** (moved up — the host for 2/3/4/5) | `src/extensions/context.ts` — `activate(ctx)` → register/onDispose/log/services; both loaders call `activateExtension` and dispose on swap/disable/delete; ambient module-scope registration still works (deprecating) | `activation context: register + dispose + teardown` |
| 2 | **Scheduler access** — extensions rolled their own `setInterval` | `ctx.poll`/`ctx.after`; tier-aware recurring pollers via the shared scheduler, one-shot delays auto-cleared | `context scheduler: poll + after, disposed on teardown` |
| 3 | **Event subscription** — the biggest missing axis; every live metric/notification/automation needed it | `src/lib/eventBus.ts`: raw engine events by `type` + derived `run.started/ended`, `tool.called/completed`, `message.appended`; `"*"` wildcard; frame-batched, crash-isolated. `ctx.on` / bridge `events.subscribe` | `event bus: …` + `store event integration: raw + derived` |
| 4 | **Curated store facade + imperative subscribe** | `src/lib/storeFacade.ts`: supported selectors/actions + non-React `subscribe`/`select`; bridge `store` is the facade, raw module is `advanced.store` (unsupported). `ctx.store` / `ctx.subscribe` | `store facade: immediate + change-gated subscribe + ctx disposal` |
| 5 | **Per-extension settings** | manifest-declared schema; core renders it in Settings › Extensions and persists per id (`src/lib/extSettings.ts`). `ctx.settings` / bridge `settings.forExt(id)` | `manifest contract: …` + `extension settings: …` |
| 8 | **Manifest `requires` + capability diagnostics** | `src/extensions/manifest.ts` parses/validates; the loader checks targets/slots/services/api each sync and records `src/lib/extensionDiagnostics.ts` warnings shown on the card (+ console) | `extension diagnostics + known slots` |
| 6 | **Generic slots for arbitrary placement** | thin: `contribute` on `slot:<id>` rendered by `src/extensions/slots.tsx` (`SLOT_IDS`, `data-oc-slot`); no new kind | `slots: contributions render in order + unregister cleanly` |
| 9 | **Peer composition** | `ctx.collections`/bridge `collections` (`get`/`list`, registry `listCollections`) + `src/lib/extBus.ts` extension-to-extension `publish`/`subscribe` (`ctx.bus`), disposed with the extension | `peer composition: collections + extension bus` |

---

## Next — E1–E7

### E1. Describe more of what happens
**Why.** Reaction-style extensions are unbounded in number and cannot be
predicted — but every derived lifecycle event we emit enables ones we never have
to learn about. Events are the only axis that is already fully generative, and
it is the cheapest place to buy capability. Today the vocabulary is thin, so
"tell me when the working tree changed" or "when a run failed" means polling or
sniffing internals.
**What.** Widen the derived vocabulary well beyond run/tool/message/focus:
session created, run failed, files changed, vcs changed, settings changed,
permission answered. Keep them engine-truthful and additive.
**Acceptance.** An extension can react to "the working tree changed" and "a run
failed" without polling, and without core knowing why it cares.
**Guardrail.** Derived events *describe*; they carry no business logic and no
extension-specific payloads.

### E2. Make the vocabulary discoverable
**Why.** You cannot document an unbounded surface — so make it queryable. We
already have the better half of the mechanism (units self-register with rich
props) and half the introspection (ids). Without props/owners/descriptions, an
author must read core source, which is precisely the friction that stops
extensions from being written. For this project it matters twice over: the agent
is authoring extensions too.
**What.** A runtime catalog over targets, slots, collections, services and
events — including the props a unit accepts — exposed to extension authors, and
reflected into the authoring docs and skill so they can be generated from it
rather than hand-maintained.
**Acceptance.** An author can ask the running app what they may render, where,
with what props, and what they may react to, and the guide/skill agree.
**Guardrail.** Additive introspection only — no new kind, no second registry, and
the catalog must describe reality rather than become a second source of truth.

### E3. Extensions own state
**Why.** The biggest capability hole. Anything non-trivial currently hand-rolls a
module-level observable plus a subscription, so state is unshareable and every
extension rebuilds the same scaffolding. This is also what makes peer
composition land: there is currently nothing for extensions to compose *over*.
**What.** Namespaced, reactive, extension-owned state — read, subscribe, select,
and optionally persist — reachable from the activation context and readable by
other extensions by id.
**Acceptance.** A non-trivial extension needs no bespoke observable, and another
extension can read its state by id.
**Guardrail.** Core state stays core's. This is ownership for extensions, not a
route into core internals — one state handle, not a second store facade.

### E4. Complete the action axis along verbs
**Why.** The facade is curated by feature, so finished, reusable capabilities sit
on the wrong side of the line: the app's whole diff-review surface and "where
does this session run" are internal, and every "hand this to the agent"
extension copy-pastes draft handling. Any future extension wanting "show me a
diff" or "navigate here" either imports internals or forks core UI.
**What.** Grow the ONE facade to cover the stable *user verbs*: navigate, resolve
where a session runs, hand a prompt to the agent (draft-safe), review changes,
pick a file, open externally, focus a surface.
**Acceptance.** An extension can open the app's diff reviewer and navigate the
app without importing core modules or hardcoding internal event strings.
**Guardrail.** Grow the existing facade — never add a parallel action surface,
and expose capabilities rather than internals.

### E5. Complete the surface vocabulary
**Why.** Extensions can express roughly half of the positions the app itself
occupies, and a page cannot choose its own layout — which is exactly why a
panel-shaped extension (side panel, dock, dashboard) cannot exist today even
though the app renders several such surfaces itself.
**What.** A layout choice for pages (dense panel vs document), slots covering
regions the app actually has (sidebar body, docks/overlays, transcript-adjacent),
and contributions that can be **ordered or removed** — "I don't want that strip"
is a use case too.
**Acceptance.** A panel-shaped extension looks native in a docked region, and an
extension can hide or reorder existing chrome without a `replace` fork.
**Guardrail.** Placement is *data*: new slots and collections, never a new kind.
Region ids are versioned contract.

### E6. Round out the proxy stratum
**Why.** Several natural extensions observe local state (files, processes) and
today must poll from the browser — laggy and expensive on a big repository. Proxy
code also has to guess engine response shapes because the client is untyped
there.
**What.** A filesystem-watch mount point, a bounded process-spawn helper,
long-lived streams, and a typed engine client.
**Acceptance.** An SCM/editor-style extension is instant and cheap instead of a
browser poll, and proxy code needs no shape guesswork.
**Guardrail.** Same trust model and same auth gate as today; mount points only,
core stays thin.

### E7. Treat the extension API as a contract
**Why.** The engine contract is snapshotted and diffed mechanically, so drift
there is caught. The extension contract is enforced by discipline instead — and
it has already drifted (a documented helper reads as "planned" though it
landed). Every rule about docs moving with the code currently relies on memory.
**What.** Snapshot the extension vocabulary (targets, slots, collections,
services, events, facade members) and diff it the way the OpenAPI snapshot is
handled; keep the authoring guide, this plan and the skill derived from it.
**Acceptance.** A change to the extension surface cannot land without the docs
and skill moving in the same commit — mechanically, not by memory.
**Guardrail.** A snapshot plus a drift check, not a new process.

---

## As-demand (item 10)

Do these when a real extension needs them, not speculatively:

- A developer **inspector** — what's registered, which targets are wrapped, hook
  fire counts, errors, bundle sizes.
- A **secrets service** for integrations.
- A **theme service** with change notification.
- Access to the **replay/event log** for timelines.
- **Hook ordering / priority.**
- **i18n.**

## Non-goals

- **No sandboxing.** Dropping a folder is an act of trust, same as host plugins.
- **Don't absorb extension features into core.** Core stays minimal; we dogfood
  the public surface or it rots.
- **Don't invent a second way to do something that exists.** Prefer the existing
  axis.
- **Don't break existing ids.** Additive changes (new optional props, events,
  slots, collections) are preferred; renames/moves require a version bump and a
  migration note.
- **Don't add a new kind** for surface or state — those become collections,
  slots, and handles.
- **Don't seal so hard that capabilities become forks** — that is what pushes
  extensions into `advanced.*` and copy-pasted core UI.

## Suggested sequencing

1. **E1** derived events — cheapest, unbounded payoff, no contract change.
2. **E2** discoverability — makes everything else self-teaching.
3. **E3** extension state — closes the biggest capability hole.
4. **E4** facade verbs — unblocks capability reuse.
5. **E5** surfaces — placement becomes expressive.
6. **E6** proxy — watchers and spawn for observer-style extensions.
7. **E7** contract discipline — lock the surface so it can't drift again.

Items 1–2 are small and make the system "already possible" rather than "ask and
we'll add it"; 3–4 unblock almost everything ambitious. Each lands with its docs
and, where it touches the contract, a version bump.

## Where to look

- `reference/extension-system-spec.md` — the contract; this doc is subordinate.
- `webui-extensions/README.md` — the authoring guide (update with every seam).
- `src/lib/extensionApi.ts` — the bridged surface and `EXT_API_VERSION`.
- `src/lib/storeFacade.ts` — the curated action/selector surface (E4).
- `src/extensions/slots.tsx` — `SLOT_IDS` and slot rendering (E5).
- `src/extensions/registry.tsx` — kinds, targets, collections, services (E2).
- `src/lib/eventBus.ts` — raw + derived event delivery (E1).
- `server/ext/types.ts` + `server/ext/registry.ts` — the proxy mount points (E6).
- `src/components/DiffViewer.tsx` — the reusable capability E4 should expose.
