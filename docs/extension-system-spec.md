# Extension System v2 — Specification & Migration Plan

Status: **agreed, not yet implemented** (decision record for the extension-system refactor).
Date: 2026-09-02.

How to read this document: sections state **what must be true** (requirements, contracts,
semantics). Where a specific mechanism is named (e.g. CJS require-cache for hot server
modules), it is the *proven suggestion*, not the mandate — the implementer may substitute
an equivalent mechanism as long as the stated property holds. If reality contradicts a
detail here during implementation, fix this document in the same commit.

---

## 1. Why we are doing this

The current extension system (`src/extensions/registry.tsx` + `ui-extensions/`) is a
list of *predicted seams*: region markers placed where we guessed users might need them,
a small versioned vocabulary of kinds, and gating through an in-repo `config.ts`. The
consequences:

- A user needing an unpredicted seam (mid-component DOM, a portal, anything inside the
  proxy process) has to fork core — and forks stop receiving updates.
- Adding/enabling/disabling an extension requires editing repo files.
- External (user-dir) extensions are second-class: narrow bridge, 8s poll, no hot edit.
- Extensions cannot cooperate with each other, and cannot run logic headless (the proxy
  only serves; it cannot be extended).
- Whole-component forks go stale on every core update — the DSH experience, where the
  fork guide literally says "re-copy the upstream bundle and re-apply your patch".

DSH's real lesson: the winning property is *the app is the default configuration of an
extension system*, not a walled garden with pre-drilled holes.

## 2. Hard requirements

1. **No forks.** User customizations live outside the repo and keep working across core
   updates. Core updates flow to customized installs unless they change the extension
   contract itself.
2. **No restarts, no refreshes** — except where genuinely unavoidable (engine plugin
   code), and then minimized by an explicit hot-reload mechanism.
3. **One method per concern.** No legacy paths, no fallbacks, no alternative ways to do
   the same thing. We are barely published: this is a clean break, not a compat layer.
4. **The engine boundary.** The opencode v2 engine/API is out of scope. We work around
   it (carry engine-plugin payloads, adapt client-side), we do not extend it.

## 3. Non-goals

- Changing engine behavior (sessions, tools the model calls, event semantics) — engine
  plugins may *carry* engine code, but engine rules apply to it.
- Sandboxing proxy-side extension code. Dropping a folder in the extension dir is an
  act of trust; same model as DSH host plugins. State it plainly, don't fake safety.
- Backward compatibility with the v1 extension kinds, regions, or `config.ts`.

---

## 4. The model in one page

One extension = **one folder** in one format, loaded by one loader, gated by one rule.
A folder may provide code in up to four *strata*:

```
my-extension/
  manifest.json    id, name, version, description, disabled (optional bool)
  index.tsx        browser stratum: register() against the registry
  dom.ts           DOM stratum: post-render DOM changes (the free layer)
  server.ts        proxy stratum: routes / middleware / event tap / pollers (in server/)
  engine/          optional opencode plugin payload (tools, system-prompt hints)
```

| Stratum | Runs in | Reaches | One method |
|---|---|---|---|
| Browser (registry) | the page | React tree, store, api calls, logic modules | wrap / replace / contribute / hook / service |
| DOM | the page, post-render | any node incl. portals, canvas, iframes | `dom.ts` + the DOM kit |
| Proxy | the proxy process | fs, spawn, engine creds, always-on event stream, all clients | `server.ts` + mount points |
| Engine | the engine process | tools the model calls, system prompt | opencode plugin rules (out of scope) |

**Gating — one state, owned by the folder itself:** presence = installed; manifest
`disabled: true` = paused. Delete/move the folder to uninstall. No `config.ts` list, no
per-browser localStorage gating, no second registry.

**Loading precedence (same id = same swap point, higher wins):**

1. `~/.config/opencode/webui-extensions/<name>/` — user
2. `<project>/.opencode/webui-extensions/<name>/` — project
3. the app's shipped `webui-extensions/` (renamed from `ui-extensions/`) — ours, updates
   with the app

A user shadowing a shipped extension = a folder with the same id at higher precedence.
Core updates land underneath; the user's still wins; nothing is forked. Our own optional
features ship as extensions in stratum 3 — we dogfood the exact same API users get,
which is what keeps that API honest.

## 5. Registry (browser stratum)

### 5.1 Five kinds — one job each

| Kind | Job | Semantics |
|---|---|---|
| `wrap` | flow-through tweak of any registered unit | Receives props/output, delegates to the live core by default. **The default path for edits** — core updates always render *through* it, so wraps are stale-proof by construction. |
| `replace` | take ownership of one registered target | Wins outright at its priority. Frozen-snapshot semantics: the owner opts out of core updates for that target (marked escape hatch). Still receives `(props, Core)` so it *can* compose if the author chooses. |
| `contribute` | add an item to a named collection | Collections are registry-owned lists: `palette`, `slash`, `pages`, `settings`, `contextMenu.message`, `contextMenu.session`, `contextMenu.file`, … Adding a collection is data in core, not a new kind. |
| `hook` | interception at instrumented boundaries | Open event strings. Fired from: the api client wrapper (every endpoint, pre/post), store middleware (every action), and lifecycle points (session adopt, pane focus, extension load, …). New seams = new event names, never a registry change. |
| `service` | provide/consume named logic | `provide` registers a consumable module (API object, cache, formatter, client). Consumption via `getService(id)`. Doubles as **value overrides**: core consults services for pluggable values (e.g. the timestamp formatter); a higher-precedence provided service wins. This is what makes "tiny logic tweaks" stale-proof. |

### 5.2 Target chains

Every registered unit (a core component or an extension replacement) is a target with an
ordered chain: `[wraps… (outermost first), replace candidates by ascending priority,
core default last]`. Evaluation: wraps transform, the winning replace renders;
**fall-through on `null`** lets a replace own specific cases and defer the rest.

### 5.3 The contract — what core must hold up

- **Auto-registration:** every core component registers itself into the registry at
  boot (via a wrapper/helper, not hand-maintained lists). The whole tree is addressable;
  no marker placement, no guessing.
- **Leaf granularity:** anything a plausible tweak point exists for is its own
  registered unit with meaningful props (the timestamp, token readout, cost badge, copy
  button — not just `MessageItem`). Parents stay core's: maintainer redesigns of
  parents and siblings reach customized installs visibly.
- **Rich props:** tweakable values arrive as props or consulted services, so wraps and
  value-overrides can be surgical.
- **Target ids, collection ids, service ids are the versioned contract.** Renaming or
  moving one is a deliberate version bump with a migration note — never a silent break.

### 5.4 The staleness test (canonical acceptance scenario)

> User tweaks only the timestamp format. Maintainer later redesigns the token counter
> and adds a finish badge in the same header. **The user gets both, visibly** — parent
> and siblings are still core's; the user's wrap delegates by default. If the maintainer
> redesigns the timestamp itself, the user's override still owns that one aspect:
> legible, tiny conflict, no fork. `replace` is the only stale-prone path, and it is
  explicitly labeled as ownership.

## 6. Hot paths — no refreshes, no restarts

- **Browser extensions (external dirs):** the proxy watches all three sources, rebuilds
  changed bundles, bumps the `?v=` version, and pushes the manifest over SSE; the page
  re-imports the bundle (browser ESM cache-busts on the query) and the registry
  same-id-swaps → live repaint. Sub-second. Replaces the 8s poll.
- **Browser extensions (repo dev):** Vite HMR — same folder format, same API; only the
  transport differs. The author never notices.
- **Proxy extensions:** no proxy restart for code edits. Proven suggestion: stat-poll +
  CJS `require` with cache deletion (the DSH-guide §10 mechanism, running in production
  in `brother-agent-live4`); an equivalent (e.g. worker-process reload) is acceptable.
  Dev's existing `--watch` proxy restart stays (SSE self-reconnects).
- **Engine payload:** engine rules apply. Optional pattern for hot tool edits: a stable
  shell plugin that stat-polls its own definitions file and swaps registrations.

## 7. DOM stratum — the free layer

For everything the React tree cannot address: mid-component DOM, **portals** (Radix/
shadcn render at `document.body`), canvas/xterm, iframes, post-render styling.

- **One entry:** `dom.ts` in the extension folder. Its presence declares DOM-level
  operation. Same loader, precedence, manifest, gating.
- **The kit (host-provided, deletes the scaffolding every DOM extension otherwise
  rebuilds):**
  - `foreign(anchor, nodes)` — sibling injection with automatic cleanup when React
    removes the anchor (the foreign-sibling registry).
  - `watch(selectors, cb)` — React-aware MutationObserver wrapper, including the
    streaming-settled signal.
  - `styles(css)` — scoped style element, auto-removed on disable/hot-swap.
  - deterministic `mount` / `dispose` lifecycle wired into hot-swap — edits repaint
    clean, never stack ghosts.
- **Our half of the bargain:** stable `data-oc-*` anchors at meaningful markup
  boundaries (message rows, composer card, tool cards, transcript), versioned like
  target ids. Without stable anchors, DOM extensions break silently on every redesign —
  this is the difference between a durable DOM layer and a Chrome extension that died
  in an update.
- **Framing rule:** React-tree change → wrap/replace; DOM-stratum change → `dom.ts`.
  Not alternatives for the same job — one method per stratum. DOM is the marked last
  resort ("outside the contract; you own the fragility").

## 8. Proxy stratum — extend the backend

The proxy (`server/index.ts`) gains mount points; its core stays thin and non-forkable,
same philosophy as the component registry. `server.ts` (or `server/` dir) may provide:

- **`routes`** — new endpoints auto-mounted at `/api/webui/ext/<id>/…` (namespaced,
  collision-free). Callable by browser extensions via the bridge and by external tools.
- **`middleware`** — wrap the `/api/*` passthrough chain: uniform request/response
  transforms affecting *all* clients (browser hooks only affect their own browser).
- **`onEvent`** — a tap into the always-on engine event subscription the recorder
  already holds. Headless reaction to session finish, tool activity, etc.
- **`pollers` / schedules** — always-on ticks (keep-alive pings, watchers) that survive
  closed tabs.
- **KV store** — one small persistent store service for server extensions (the
  `~/.dsh/brother-watches.json` equivalent) so each doesn't roll its own file I/O.

Examples this unlocks: headless session-finished webhooks; brother-watcher (queue
finish notices into parent sessions 24/7); cache-keepalive pings that survive tab
close; server-side secrets (Groq key in the proxy instead of localStorage); endpoints
for external scripts/cron; uniform response rewriting and rate limiting.

## 9. Engine payload (boundary respected)

An extension folder may carry `engine/` — a valid opencode plugin directory (tools the
model calls, `experimental.chat.system.transform` prompt hints, commands). The webui
neither loads nor hot-reloads it; the engine's rules apply (boot-time load, restart on
edit unless the plugin implements its own shell pattern). The engine's `PluginInput`
already provides a client and a Bun shell, so plugins need no HTTP self-RPC.

Worked example — brother-agent in webui terms, one folder, three strata:
`engine/` registers the `brother_agent*` tools; `server.ts` taps events and queues
finish notices into parents headless; `index.tsx` renders the sidebar badge.

## 10. Deletions — the clean break

Removed outright, no aliases, no deprecation period:

- `<Slot region>` markers, the regions table, `bun run regions`.
- `ui-extensions/config.ts` and the `enabled` list (→ folder presence + manifest).
- The in-repo vs runtime-plugin extension classes — one loader, three sources.
- Kinds `region`, `message`, `message.decoration`, `message.part`, `tool.renderer`
  (→ wrap/replace on registered units; tool-specific matching is logic inside the wrap
  plus fall-through).
- Kinds `command`, `slash`, `page`, `settings`, `contextMenu` (→ one `contribute` kind
  with a `collection` field).
- Per-browser localStorage extension gating.
- The 8s extension poll (→ SSE manifest push).
- The narrow `window.__opencodeUI` bridge → **one extension API surface**
  (`register`, `react`, `api`, `store`, `prefs`, `notify`, `services`, `dom` kit,
  `kv`) used identically by external extensions and our shipped ones.
- Repo folder `ui-extensions/` renamed to `webui-extensions/` (naming parity with the
  user/project dirs).

## 11. Implementation order

1. **Registry v2** — five kinds, target chains, auto-registration helper.
2. **Instrumentation** — api client wrapper + store middleware + lifecycle hook fires
   (hooks exist everywhere, once).
3. **Loader** — 3-source discovery/build/serve, precedence, watcher + SSE manifest push.
4. **Core migration** — all components self-register; delete regions/Slot/config/old
   kinds in the same sweep.
5. **DOM stratum** — `dom.ts` entry, kit, `data-oc-*` anchors in core markup.
6. **Bridge unification** — the single extension API surface.
7. **Proxy stratum** — `server.ts` mount points + KV + hot server modules.
8. **Engine payload convention** — small; document, don't build engine machinery.

## 12. Documentation updates (first-class plan items — docs are as important as the code)

A contract that isn't documented doesn't exist. These ship with the refactor, not after:

### 12.1 `AGENTS.md` — rewrite the Extensions section + add "making changes going forward"

The new AGENTS.md must state the architecture (strata, one folder, precedence, one
method per concern) and carry a standing rules section for us and contributors so the
system stays free and extensible:

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

### 12.2 Authoring guide (replaces `ui-extensions/README.md`)

New `webui-extensions/README.md`: the one-format folder anatomy, the five kinds with
staleness semantics (wrap = default, replace = ownership, dom = outside the contract),
the collections list, hook event catalog, service examples, the DOM kit, `server.ts`
mount points, the engine payload note, precedence, and the hot-reload guarantees.
Include the timestamp test as the worked example of choosing the right stratum.

### 12.3 `skills/webui/` (repo) and `~/.config/opencode/skills/webui/` (installed)

The skill must be rewritten to the new model: how to add/change/disable extensions, the
five kinds, choosing a stratum, the standing rules summary, and where the authoring
guide lives. Reinstall/copy so both locations match.

### 12.4 Other docs

- `docs/coverage.md` — new proxy endpoints (`/api/webui/ext/*`, manifest SSE), loader
  behavior; remove references to regions/config gating.
- `src/extensions/registry.tsx` header comment — the v2 contract summary (kinds, ids,
  versioning) pointing at the authoring guide.
- Root `README.md` — extension story blurb (one folder, drop it in, three sources).
- This document stays as the decision record; mark sections "implemented" as they land.

## 13. Acceptance checks

- **Timestamp test** (§5.4) passes end-to-end: wrap tweak + core sibling update both
  visible; replace ownership legible.
- Drop a folder into the user dir on a production install → it loads without rebuild,
  refresh, or restart; edit it → live repaint; set `disabled: true` → gone; delete →
  uninstalled.
- Same-id precedence: user dir shadows shipped; shipped updates still flow everywhere
  else.
- Deleting `<Slot>`, regions, config.ts, old kinds leaves zero references
  (`grep -r` clean; `bun run typecheck` green).
- A `server.ts` extension's poller/event reaction works with all browser tabs closed.
- A `dom.ts` extension survives a session switch and a hot edit without leaked nodes.
