# Extension system roadmap 2 — opening the axes

> **Status:** proposal. Continues `docs/extension-roadmap.md`, whose items 1–9
> **landed** in `EXT_API_VERSION` 2 / release 3.0.0 (its item 10 stays the
> as-demand bucket). Items below are new; `E1`–`E7` numbering is local to this
> doc. This doc says *why* and *what*; if a design here conflicts with
> `docs/extension-system-spec.md`, the spec wins and this doc gets updated.

## Why this exists

The first roadmap gave every axis a seam, and that worked: events, scheduler
access, settings, slots, lifecycle and peer composition all exist now. The
remaining problem is not a missing axis — it is **qualitative**.

Three of those seams are *enumerations*: a fixed list of slot ids, a fixed list
of facade actions, core-owned state with a fixed set of selectors. An
enumeration can only grow when someone foresees a need, so an extension's reach
is capped by lists we maintain by hand — and the more imaginative the user, the
harder they hit the cap.

So the goal of this doc is not more features. It is to make each axis **open
under composition**: given any use case, there should be a compositional answer
on every axis. Curate *shapes*, not features.

| Axis | After items 1–9 | What is still closed |
| --- | --- | --- |
| **Observe** | landed — `ctx.on`, raw + derived, `"*"` | the derived vocabulary is thin (few lifecycle events) |
| **Place** | partial — fixed `SLOT_IDS` + one page layout | extensions can claim ~5 regions; pages can't choose their layout; nothing can be removed |
| **Transform** | strong — wrap / replace / service | nothing needed |
| **Act** | landed — curated facade | curated by *feature*, so reusable capabilities sat on the wrong side of the line |
| **Persist + configure** | landed — `settings` + `kv` | state is core-owned; extensions can't own or share any |
| **Schedule** | landed — `ctx.poll` / `ctx.after` | nothing needed |
| **Compose** | landed — `collections` + `bus` | nothing to compose *over*: no extension-owned state, and `requires` can't check collections |
| **Discover** *(new)* | half — ids only | targets' props, owners, descriptions are invisible |
| **Compute** *(proxy)* | shape is right | no filesystem watch, no spawn helper, untyped engine client |

## The test to apply to every future request

The parent doc's test (buildable without editing core, the DOM stratum, raw
timers, or `src/` imports) still stands. Add the **closure test**:

> Can an extension occupy every **position**, read every **state**, and call
> every **verb** that the app itself uses?

Core is the existence proof. Whatever shape core uses internally, an extension
must be able to use — so gaps are found by *diffing two vocabularies*, not by
imagining use cases: list the positions core renders, the reads/writes its store
performs, the verbs it exposes to users, and the computations its proxy does;
subtract what extensions can reach. Every difference is a gap by definition.

Keep the probe cookbook and re-run it. **The probe that motivated this doc was
a source-control panel** (change list, branch, commit graph, diff review). It is
not part of this repo's shipped extensions, but it remains the reference use
case: it exposed the placement cap, the state-ownership hole, the internal-only
diff reviewer, the thin discoverability, and the missing proxy watcher in one
feature.

## Rules for any change here

The parent doc's rules apply unchanged (widen an axis; one method per concern;
versioned contracts; stale-proof; crash-isolated; docs move with the code).
Two additions:

- **Curate shapes, not features.** A closed set of *verbs/regions/axes* composes
  into unbounded use cases; a closed set of *features* is permanently behind.
- **Names below are working names.** The implementer owns the final shape, and
  the contract bump + migration note lands with it.

---

## The changes

### E1. Describe more of what happens
**Why.** Reaction-style extensions are unbounded in number and cannot be
predicted — but every derived lifecycle event we emit enables ones we never have
to learn about. Events are the only axis that is already fully generative, and
it is the cheapest place to buy capability. Today the vocabulary is thin, so
"tell me when the working tree changed" or "when a run failed" means polling or
sniffing internals.
**What.** Widen the derived vocabulary well beyond run/tool/message/focus:
things like session created, run failed, files changed, vcs changed, settings
changed, permission answered. Keep them engine-truthful and additive.
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
with what props, and what they may react to, and the guide/skill agree with the
answer.
**Guardrail.** Additive introspection only — no new kind, no second registry,
and the catalog must describe reality rather than become a second source of
truth.

### E3. Extensions own state
**Why.** The biggest capability hole. Anything non-trivial currently hand-rolls
a module-level observable plus a subscription, so state is unshareable and every
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
**Why.** The facade is curated by feature, so finished, reusable capabilities
sit on the wrong side of the line: the app's whole diff-review surface and
"where does this session run" are internal, and every "hand this to the agent"
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
today must poll from the browser — which is both laggy and, on a big repository,
expensive. Proxy code also has to guess engine response shapes because the
client is untyped there.
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
handled; keep the authoring guide, this roadmap and the skill derived from it.
**Acceptance.** A change to the extension surface cannot land without the docs
and skill moving in the same commit — mechanically, not by memory.
**Guardrail.** A snapshot plus a drift check, not a new process.

---

## Non-goals

The parent doc's non-goals hold (no sandboxing; don't absorb extension features
into core; no second way to do anything; don't break ids). Two more, specific to
this phase:

- **Don't add a new kind** for surface or state. Those become collections,
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
we'll add it"; 3–4 unblock almost everything ambitious.

## Where to look

- `docs/extension-roadmap.md` — the parent; its items 1–9 are the landed seams.
- `webui-extensions/README.md` — the authoring guide (update with every seam).
- `src/lib/extensionApi.ts` — the bridged surface and `EXT_API_VERSION`.
- `src/lib/storeFacade.ts` — the curated action/selector surface (E4).
- `src/extensions/slots.tsx` — `SLOT_IDS` and slot rendering (E5).
- `src/extensions/registry.tsx` — kinds, targets, collections, services (E2).
- `src/lib/eventBus.ts` — raw + derived event delivery (E1).
- `server/ext/types.ts` + `server/ext/registry.ts` — the proxy mount points (E6).
- `src/components/DiffViewer.tsx` — the reusable capability E4 should expose.
