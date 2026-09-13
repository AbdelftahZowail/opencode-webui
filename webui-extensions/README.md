# Extension authoring guide (v2)

One extension = **one folder** in one format, loaded by one loader, gated by
one rule. A folder may provide code in up to four *strata* — pick the stratum
that matches the job (framing rule below), never two for the same job.

```
my-extension/
  manifest.json    id, name, version, description; optional disabled, settings, requires, capabilities
  index.tsx        browser stratum: register() and/or activate(ctx)
  dom.ts           DOM stratum: post-render DOM changes (the free layer)
  server.ts        proxy stratum: routes / middleware / event tap / pollers
  engine/          optional opencode plugin payload (tools, system-prompt hints)
```

```jsonc
// manifest.json
{ "id": "my-extension", "name": "My extension", "version": "1.0.0",
  "description": "What it does" /* "disabled": true — paused */,
  // Declared settings (roadmap 5): core renders these in Settings › Extensions.
  "settings": [
    { "key": "enabled", "type": "boolean", "title": "Enabled", "default": true },
    { "key": "threshold", "type": "number", "title": "Threshold", "default": 5, "min": 1, "max": 20 },
    { "key": "mode", "type": "enum", "title": "Mode", "options": ["fast", "thorough"], "default": "fast" }
  ],
  // Checkable references (roadmap 8): an unmet one is a visible warning.
  "requires": { "api": 1, "targets": ["message.timestamp"], "slots": ["composer.above"] },
  "capabilities": ["notify"] }
```

**Gating — one state, owned by the folder itself:** presence = installed;
`disabled: true` = paused; delete/move the folder to uninstall. No
`config.ts` list, no per-browser localStorage gating, no second registry.
User-facing pause (a settings toggle that stops *behavior*, e.g. an
extension that idles when its key/feature flag is off) is not manifest
pausing: the former keeps the entry loaded but quiet, the latter
(`disabled: true`) is never bundled or imported and its id unregisters —
use a settings toggle for "off for now", the manifest for "unplug".

**Settings › Extensions** renders one card per installed extension (its
`name`/`description` from `manifest.json`) with an on/off switch, plus any
`settings` collection the extension contributes, inline in that card. The
switch is just a UI for the folder flag above: it calls
`POST /api/webui/extensions/<id>/state { disabled }`, which edits the winning
folder's `manifest.json`. A **shipped** id is never edited in place (an app
update would clobber the flag) — disabling it writes a user-level shadow
folder with the same id, removed again on re-enable (shipped browser bundles
are glob-owned, so re-enabling reloads the page to re-register them).

**Precedence (same id = same swap point, higher wins):**

1. `~/.config/opencode/webui-extensions/<name>/` — user
2. `<project>/.opencode/webui-extensions/<name>/` — project
3. the app's shipped `webui-extensions/` — ours, updates with the app

Shadowing a shipped extension = a folder with the same id at higher
precedence. Core updates land underneath; yours still wins; nothing is
forked. Dropping a folder in the extension dir is an act of trust —
extension code is not sandboxed (same model as host plugins).

> Implementation status: the registry (five kinds), hook instrumentation,
> browser loader + manifest SSE, proxy-stratum mounts, `dom.ts` loader wiring
> + `data-oc-*` stamping, core self-registration, and the `ui-extensions/` →
> `webui-extensions/` rename are landed (`docs/extension-system-spec.md` §11).
> The **roadmap seams are landed too** (`docs/extension-roadmap.md` items 1–9,
> `EXT_API_VERSION` 2): prop-transforming wraps, the activation context +
> disposal, scheduler access, the event bus, the curated store facade,
> declared settings, thin slots, manifest `requires` diagnostics, and peer
> composition. The contract below is what that work converged on — write to it.

## Choosing a stratum (framing rule)

- React-tree change → **browser stratum** (`wrap`/`replace`/`contribute`/
  `hook`/`service` in `index.tsx`).
- Mid-component DOM, portals, canvas/xterm, iframes, post-render styling →
  **DOM stratum** (`dom.ts`). The marked last resort: outside the contract,
  you own the fragility.
- Headless logic, always-on ticks, secrets, endpoints for external tools,
  uniform request/response transforms → **proxy stratum** (`server.ts`).
- Tools the model calls, system-prompt hints → **`engine/` payload**
  (opencode plugin rules apply — boot-time load, engine restarts).

## Browser stratum — five kinds, one job each

`register()` lives in `src/extensions/registry.tsx` — that file's header
comment is the contract summary; this guide is the long form. Staleness
semantics are the whole point: `wrap` = default, `replace` = ownership.

| Kind | Job | Staleness |
| --- | --- | --- |
| `wrap` | Flow-through tweak of any registered target: `render(props, next)` — transform output, and/or call `next(overrides)` to merge changed/extra props into the rest of the chain, delegating to live core by default | **Stale-proof by construction.** Core updates always render *through* it. The default path for edits. |
| `replace` | Take ownership of one registered target: `render(props, core)` wins outright at its priority; return `null` to fall through to the next candidate / core | **Frozen snapshot.** You opt out of core updates for that target — the marked escape hatch. Still receives `core` so you *can* compose. |
| `contribute` | Add an item to a named collection (`collection` + `item`, `order` sorts, lower first) | Data, not code — core owns the list, you own your row. |
| `hook` | Interception at instrumented boundaries: `{ event, handler(ctx, next) }` — `event` is an open string | New seams are new event names, never a registry change. |
| `service` | Provide named logic: `{ service, value, precedence }` — consume via `getService(id)`; highest precedence wins | **Value overrides.** Core consults services for pluggable values (e.g. the timestamp formatter), so tiny logic tweaks never touch markup. |

Target chains (§5.2 of the spec): every registered unit is a target with an
ordered chain — wraps outermost-first, replace candidates by ascending
priority, core default last. Evaluation: wraps nest, the first replace
returning non-null wins, `null` falls through to core. Every core component
self-registers at boot (auto-registration helper — the whole tree is
addressable, no marker placement, no guessing), at leaf granularity (the
timestamp, token readout, cost badge, copy button — not just `MessageItem`),
with rich props, so wraps and value-overrides stay surgical.

### Target inventory (the catalog — grep `autoRegister` if this lags)

| Target id | Props (meaningful subset) |
|---|---|
| `sidebar` | — (the shell) |
| `sidebar.sessionRow` | `sessionID`, `title`, `updated`, `active`, `selected`, `subagentsActive`, `onSelect` |
| `conversation` | full `ConversationProps` |
| `conversation.header` | full `HeaderProps` |
| `conversation.empty` | — |
| `composer` | full `ComposerProps` |
| `composer.contextReadout` | `parts: string[]`, `sessionID` |
| `composer.sendActions` | `sessionID`, `appendDraft(text)` — space-joins onto the draft + refocuses; prefer over writing drafts directly |
| `message.timestamp` | `time: number` (consults the `format.timestamp` service) |
| `message.tokens` | `tokens` |
| `message.cost` | `cost: number` |
| `message.copyButton` | `variant: "user" \| "assistant"`, `text` |
| `message:<type>` / `message:*` | replace-with-fall-through per message type |
| `tool.card` | `part: ToolPart`, `stateKey?` |
| `tool.edit` / `write` / `shell` / `subagent` / `execute` / `read` / `generic` | per-tool view props |
| `tool:<name>` | replace-with-fall-through per tool name |

Persisted-vs-live guarantee (streaming authors depend on this): persisted
messages always carry a `[data-oc-message]` ancestor; live projections
(`LiveAssistantView`) render `MessagePart` directly with none. Code that
must never touch streaming output can rely on the distinction structurally.

### Entry hygiene (two rules that bite silently)

- **One entry per id.** Same-id `register()` SWAPS (with a console warning
  when kind/target differ) — a folder's entries need distinct ids or the
  later evicts the earlier, and loaders track folders by single id so extras
  leak on disable/delete. One folder → one id per entry, always.
- **Runtime code uses the bridge only.** External (user/project-dir) bundles
  are built standalone: `import type` from `src/` is erased at build and
  safe, but any *runtime* `src/` import breaks the copy outside the repo.
  Use `window.__opencodeUI` (`register`, `react`, `api`, `store` [the curated
  facade], `events`, `settings`, `collections`, `bus`, `prefs`, `notify`,
  `services`, `dom`, `kv`; raw modules as `advanced.*`) — shipped code consumes the identical
  surface via `getExtensionApi()`.
- **The `@/` alias works in shipped extensions only.** Same repo, same
  tsconfig (`@/*` → `./src/*`, e.g. a shipped extension imports
  `@/components/ui/dialog`) — external copies must still use the bridge,
  never `@/` or relative `src/` paths.

### Activation (lifecycle) — the shape to write

`index.tsx` may export an activation entry instead of registering at module
scope:

```tsx
export const id = "my-extension";

export function activate(ctx) {
  ctx.register({ kind: "wrap", id: "my-wrap", target: "message.timestamp", render: … });
  const stop = someObserver(); // timer, listener, subscription…
  ctx.onDispose(stop);          // or: return stop
}
```

- `ctx.register(entry)` — the same five kinds; the id is remembered so
  teardown prunes exactly this extension's entries.
- `ctx.poll({ name, minInterval, intervals?, whenHidden?, run })` — recurring
  work on the shared scheduler (tier-aware, jittered; the app's only timer
  owner). Returns an idempotent stop; stopped automatically on dispose.
- `ctx.after(ms, fn)` — one-shot delay; returns an idempotent cancel; cleared
  automatically on dispose.
- `ctx.on(name, handler)` — subscribe to the event bus (raw engine type or
  derived lifecycle name; `"*"` = all). Returns an unsubscribe; removed
  automatically on dispose. See **Events (observe)** below.
- `ctx.subscribe(selector, listener)` — derived store read: fires immediately,
  then only when the selected value changes (shallow-equal). Auto-removed on
  dispose. See **Store (read + act)** below.
- `ctx.store` — the curated store facade (selectors + actions); the same
  object as the bridge's `store`.
- `ctx.settings` — resolved declared settings (`get`/`set`/`reset`/`subscribe`);
  subscriptions disposed with the extension. See **Declared settings +
  requirements**. No manifest schema → empty handle (use `kv` for ad-hoc data).
- `ctx.collections` — read other extensions' contributions (`get(collection)`)
  and every live collection id (`list()`). See **Peer composition**.
- `ctx.bus` — extension-to-extension events: `publish(channel, payload)`
  (tagged with this id) and `subscribe(channel, fn)` (disposed with the
  extension). See **Peer composition**.
- `ctx.onDispose(fn)` / returning a teardown fn — runs on hot-swap,
  `disabled: true`, and delete (LIFO, crash-isolated). This is the one place
  non-React cleanup belongs — no `window.__*Installed` guards.
- `ctx.log(...)` — prefixed with the extension id.
- `ctx.services.getService` / `getServiceProviders` — named-logic lookups.

Module-scope `register({…})` still works (the loaders fall back to the
registry id-delta), but it is the shape being deprecated: nothing outside the
module can dispose what the module did, so `disabled`/delete/hot-swap can't
tear down listeners or timers it started. New extensions write `activate`.
The DOM stratum already has this contract (`mount` returns a cleanup fn).

### Events (observe)

`ctx.on(name, handler)` (or the bridge's `events.subscribe`) observes what
happened without diffing store snapshots. Two families share one channel:

- **Raw engine events** — every event the store reduces, under its engine
  `type` (`session.tool.success`, `session.text.delta`, `permission.asked`,
  `session.idle`, …). Payload is the event's `data`.
- **Derived lifecycle events** — core computes these so you don't infer them:
  `run.started` `{sessionID}` · `run.ended` `{sessionID,reason}` ·
  `tool.called` `{sessionID,assistantMessageID,id,name,input?}` ·
  `tool.completed` `{sessionID,assistantMessageID,id,name?,ok}` ·
  `message.appended` `{sessionID,messageID,type}`.

```tsx
ctx.on("tool.completed", (e) => {
  const { name, ok } = e.payload;
  usage[name] = (usage[name] ?? 0) + (ok ? 1 : 0);
});
ctx.on("run.ended", () => notify({ title: "Run finished" }));
```

Delivery is frame-batched (16ms) so a token burst is one dispatch per frame.
`"*"` receives everything (diagnostics/analytics — it is per-event, so filter).
Listeners are crash-isolated; the subscription is disposed with the
extension. The bus is notification-only: it never mutates state and
extensions cannot publish.

### Store (read + act)

`ctx.store` (bridge: `store`) is the curated, **supported** store surface —
selectors and actions, never the raw module (which stays reachable, and
explicitly unsupported, as `advanced.store`):

- **observe:** `subscribe(listener)`, `select(selector, listener)`,
  `useStore(selector)` (React), `getState()` (full snapshot)
- **read:** `currentSessionID()`, `sessions()`, `sessionDetail(id)`,
  `messages(id)`, `liveAssistants(id)`, `isRunning(id)`, `isQueued(id)`,
  `pendingRequests()`, `isDraftSession(id)`, `sessionHref(id)`
- **act:** `sendPrompt`, `sendPromptTo(id, text, {delivery?})`,
  `selectSession`, `navigateFocused`, `newSession`, `materializeDraft`,
  `replyPermission`, `replyForm`, `replyQuestion`, `rejectQuestion`,
  `interrupt`, `switchAgent`, `switchModel`, `renameSession`,
  `compactSession`, `undoSession`, `redoSession`, `activateSkill`

```tsx
// ctx.subscribe auto-disposes; ctx.store.select is the manual form.
ctx.subscribe((s) => s.currentSessionID, (id) => badge.textContent = id ?? "");
```

Core keeps adding internal state/actions — those do **not** become API. A new
extension need means a deliberate addition to the facade (version bump), not
reaching into `advanced.store`.

### Declared settings + requirements (manifest)

Two optional `manifest.json` blocks turn a fragile extension into a checkable
one.

**`settings`** — declare options once; core renders them in the extension's
Settings card and persists per id (defaults applied, invalid/legacy values
dropped). The extension just reads resolved values via `ctx.settings` (or the
bridge's `settings.forExt(id)`):

```tsx
export function activate(ctx) {
  const apply = () => (opts = ctx.settings.get());
  apply();
  ctx.settings.subscribe(apply); // auto-disposed
}
```

Schema subset per field: `{ key, type, title, description?, default? }` where
`type` is `boolean | number (min/max/step) | string (placeholder) | enum
(options: string[])`. That covers the common toggle/threshold/format option
with no bespoke settings component or storage.

**`requires`** — declare the references you depend on
(`api` version, `targets`, `slots`, `services`). Core checks them every
manifest sync; an unmet one becomes a visible warning in your Settings card
(`⚠ unmet target "…"`) plus a console warning, instead of a silently blank
spot. `capabilities` is free-form declared metadata.

Static shape problems (bad `settings`/`requires`) are reported the same way —
never swallowed.

### Peer composition

Extensions cooperate through two read-only surfaces — neither imports the
other:

- **Collections** — read what any extension contributed:
  `ctx.collections.get("palette")` (or the bridge's `collections.get`), plus
  `ctx.collections.list()` for every live collection id. Contributing is the
  existing `contribute` kind; consuming another's items is just reading.
- **The peer bus** — extension-to-extension events:
  `ctx.bus.subscribe(channel, fn)` and `ctx.bus.publish(channel, payload)`
  (the event carries `from: <publisher id>`). Channels are free-form strings;
  delivery is synchronous and low-frequency (coordination, not streams).
  Subscriptions are disposed with the extension.

```tsx
// provider
ctx.register({ kind: "contribute", id: "my-metric", collection: "metrics", item: { label: "TPS" } });
// consumer — same-page, no import
ctx.bus.subscribe("metrics.changed", ({ from }) => refresh(ctx.collections.get("metrics")));
ctx.bus.publish("metrics.changed", {});
```

`service` still covers one-to-one provide/consume; this covers many-to-many.

```tsx
// index.tsx — wrap the timestamp, own nothing else
import { register } from "../../src/extensions/registry";

register({
  kind: "wrap",
  id: "my-timestamps-wrap",
  target: "Timestamp",
  render: (props, next) => (
    <span title={String(props.iso ?? "")}>{next()}</span>
  ),
});

register({
  kind: "service",
  id: "my-timestamps-format",
  service: "format.timestamp",
  value: (iso: string) => new Date(iso).toLocaleTimeString(),
  precedence: 10,
});
```

```tsx
// index.tsx — a wrap that FEEDS the target changed props, not just output.
// `next(overrides)` shallow-merges overrides into every remaining wrap and
// the leaf (core default / winning replace). With no argument, behavior is
// exactly as before. Overrides never change the wrap's own `props`.
register({
  kind: "wrap",
  id: "my-append-action",
  target: "composer.sendActions",
  render: (props, next) =>
    next({ extraActions: [...(props.extraActions as unknown[]), <MyButton />] }),
});
```

```tsx
// index.tsx — replace with fall-through: own one case, defer the rest
register({
  kind: "replace",
  id: "my-tool-card",
  target: "tool:bash",
  render: (props, core) =>
    (props as any).summary === "banner" ? <MyBanner {...(props as any)} /> : core(props),
});
```

### Collections (`contribute`)

Collections are registry-owned lists — adding a collection is data in core,
not a new kind. Current ids: `palette` (command palette; item
`{ title, run, keybind? }` — `keybind: "ctrl+shift+k"` for a global hotkey),
`slash` (Composer `/name`; item `{ name, description?, aliases?, run }` —
UI-only, local `run(args, { sessionID })`; engine commands come from
`GET /api/command` + `GET /api/skill` and win name clashes), `pages`
(item `{ title, description?, render }`, routed at `/ext/{id}`),
`settings` (item `{ title, description?, render }`, section in
Settings › Extensions), `contextMenu.message`, `contextMenu.session`,
`contextMenu.file` (item `{ label, run, order? }`), and the `slot:<id>`
placement collections (see Slots below).

```tsx
register({
  kind: "contribute",
  id: "my-page",
  collection: "pages",
  item: { title: "Uptime", render: () => <Uptime /> },
});
```

### Slots (placement)

A **slot** is a named insertion point in core chrome — placement, not
identity. Targets render a unit's component chain (something with an id you
tweak); slots render whatever anyone contributed to a place. Same `contribute`
kind, collection `slot:<slotID>`:

```tsx
register({
  kind: "contribute",
  id: "my-compose-badge",
  collection: "slot:composer.above",
  item: { render: ({ sessionID }) => <span>draft for {sessionID}</span> },
});
```

Known slot ids (the versioned registry, `src/extensions/slots.tsx`):
`conversation.header.actions`, `conversation.empty`, `composer.above`,
`composer.actions`, `sidebar.header.actions`. Contributing to an unknown
`slot:<id>` renders nowhere — declare it in `requires.slots` to get a warning
instead. Items sort by `order` (lower first); each is crash-isolated; the
stamp site carries `data-oc-slot="<id>"` for the DOM stratum. Renaming/moving
a slot id is a contract bump + migration note.

### Hook catalog

Open event strings — fired from the api client wrapper (every endpoint),
store middleware (every action), and lifecycle points. A new seam is a new
`fireHooks("name", ctx)` call in core, never a registry change.

| Event | `ctx` shape | When |
| --- | --- | --- |
| `api.pre` | `{ name, args }` — MUTATE `ctx.args` (unknown[] spread into the endpoint) | Before every api client call; `await`ed so mutations apply |
| `api.post` | `{ name, args, result }` — observe | After every successful api call |
| `api.error` | `{ name, args, error }` — observe; the original error is rethrown | After every failed api call |
| `store.dispatch` | `{ patch, state }` — observe | Store middleware, every action (sync site — `void fireHooks`) |
| `session.prompt` | `{ text, sessionID }` — mutate `ctx.text` to transform; `await`ed | Composer submit before `POST /api/session/{id}/prompt` |
| `session.adopted` | `{ sessionID }` | Session becomes the focused session |
| `pane.focused` | `{ paneID, sessionID }` | Split-view focus moves to a pane |
| `extension.loaded` | `{ id, url }` | A browser extension bundle finished loading |
| `message.render` | `{ message, sessionID? }` — mutate `ctx.message` (shallow clone) before render | `MessageItem` before the message renderer |

```tsx
register({
  kind: "hook",
  id: "my-prefix",
  event: "session.prompt",
  handler: (ctx, next) => { ctx.text = `[via webui] ${ctx.text}`; next(); },
});
```

Handlers run sequentially in registration order; each is crash-isolated (a
throwing extension never breaks the core path). Browser hooks affect only
their own browser — for transforms affecting *all* clients, use proxy
`server.ts` middleware instead.

## DOM stratum — the free layer

For everything the React tree cannot address: mid-component DOM,
**portals** (Radix/shadcn render at `document.body`), canvas/xterm, iframes,
post-render styling. One entry: `dom.ts` in the extension folder — its
presence declares DOM-level operation; same loader, precedence, manifest,
gating. Default-export `{ mount(kit), dispose? }`; `mount` may return a
cleanup fn. Hot-swap runs every registered cleanup + `dispose`, so edits
repaint clean and never stack ghosts.

The kit (`src/lib/domKit.ts`, host-provided so DOM extensions don't each
rebuild the scaffolding):

- `foreign(anchor, nodes)` — sibling injection with automatic cleanup when
  React removes the anchor (the foreign-sibling registry).
- `watch(selectors, cb)` — React-aware MutationObserver wrapper, including
  the streaming-settled signal (`onStreamingSettled`).
- `styles(css)` — scoped `<style>` element, auto-removed on
  disable/hot-swap.

Our half of the bargain: stable `data-oc-*` anchors at meaningful markup
boundaries, versioned like target ids (renaming/moving one = contract bump
+ migration note, never a silent break). Without stable anchors, DOM
extensions break silently on every redesign.

| Anchor | Site |
| --- | --- |
| `data-oc-transcript` | MessageScroller content |
| `data-oc-message` + `data-oc-message-id` + `data-oc-message-type` | MessageItem root per type branch |
| `data-oc-composer` + `data-oc-composer-input` + `data-oc-composer-send` | Composer card, textarea, send button |
| `data-oc-tool-card` + `data-oc-tool-name` | ToolCard root + tool call name |
| `data-oc-session-header` | Conversation header bar |
| `data-oc-sidebar` | Sidebar root |
| `data-oc-queue-strip` | QueueStrip (steer/queue rows) |
| `data-oc-subagent-strip` | SubagentStrip |
| `data-oc-runs-panel` | RunsPanel |
| `data-oc-slot` | Slot wrapper (`slot:<id>` — one per known slot id) |

```ts
// dom.ts — badge next to the send button, cleaned up on hot-swap
export default {
  mount({ foreign, watch, styles }) {
    styles(`[data-my-badge]{font-size:11px;opacity:.7}`);
    const clean = watch(["[data-oc-composer-send]"], (sends) => {
      for (const el of sends)
        foreign(el, [`<span data-my-badge>via ext</span>`]);
    });
    return clean;
  },
};
```

## Proxy stratum — `server.ts` mounts

The proxy stays thin and non-forkable; `server.ts` (or a `server/` dir) may
provide any of `routes`, `middleware`, `onEvent`, `pollers` — default-export
the object, no core import needed (the loader validates the shape
structurally). Full types: `server/ext/types.ts`.

- **`routes`** — new endpoints auto-mounted at `/api/webui/ext/<id>/…`
  (namespaced, collision-free). Callable by browser extensions via the
  bridge and by external tools. Unknown id/route never falls through to the
  engine.
- **`middleware`** — `onRequest` (return a Response to short-circuit, a
  Request to replace, void to pass through) / `onResponse` (replace the
  upstream response). Wraps the `/api/*` passthrough chain: uniform
  transforms affecting *all* clients.
- **`onEvent`** — a tap into the always-on engine event subscription the
  recorder already holds. Headless reaction to session finish, tool
  activity, etc. — works with all browser tabs closed.
- **`pollers`** — `{ id, intervalMs, run }` always-on ticks (keep-alive
  pings, watchers) that survive closed tabs.
- **KV store** — one small persistent JSON-file-backed store per extension
  (`ctx.kv`), so each doesn't roll its own file I/O.

No proxy restart for code edits: the loader stat-polls (2s) and re-imports
with `?v=<mtime>` cache-bust. Dev's existing `--watch` proxy restart stays
(SSE self-reconnects).

```ts
// server.ts — headless finish webhook + its config endpoint
export default {
  routes: [{
    method: "POST", path: "notify",
    handler: async (req, ctx) => {
      const { url } = await req.json() as { url: string };
      await ctx.kv.set("webhook", url);
      return Response.json({ ok: true });
    },
  }],
  onEvent: async (evt, ctx) => {
    if (evt.type !== "session.finished") return;
    const url = await ctx.kv.get("webhook");
    if (url) await fetch(url, { method: "POST", body: JSON.stringify(evt) });
  },
  pollers: [{ id: "keepalive", intervalMs: 60_000, run: async () => {} }],
};
```

## Engine payload (`engine/`)

An extension folder may carry `engine/` — a valid opencode plugin directory
(tools the model calls, `experimental.chat.system.transform` prompt hints).
The webui neither loads nor hot-reloads it; the engine's rules apply
(boot-time load, restart on edit unless the plugin implements its own shell
pattern — a stable `index.js` that require-cache-busts a `definitions.cjs`
on mtime works and is the recommended shape). Convention + worked example (one folder, three strata):
`docs/engine-payload-convention.md`. Hard-won facts, stated once so no one
re-discovers them by trial:

- **Export shape:** `module.exports = { id, setup }` (v2 — the v1 `{server}`
  / named-export shape is rejected: "must export a default definition with
  an id and an effect or setup function").
- **Tool namespace:** the model lists tools as `tools.<name>` — register and
  match on the `tools.`-prefixed name, never bare.
- **Tool results must resolve `{ output: string }`.** A bare string fails
  result validation (`Unknown tool` in the transcript).
- **System-hint parts need `{ type: "text", text }`.** Pushing `{text}`
  without `type` fails the whole session drain (schema `MissingKey`).
- **Session origin tagging** (`metadata: { origin: "…" }`) survives only via
  REST `POST /api/session` create — the setup-bridge create drops it.
- **Discovery + auth:** the engine registers at
  `$XDG_STATE_HOME/opencode/service.json` (Basic `opencode:password` —
  mirror `@opencode-ai/client`'s service helper); provider credentials live
  under `XDG_DATA_HOME`, so a `STATE`-only sandbox sees the engine but no
  models. When agent testing misbehaves, verify the provider first with
  `POST /session/{id}/generate {"prompt":"OK"}`; when runs fail blank,
  the cause is in `$XDG_DATA_HOME/opencode/log/opencode.log` (`grep drain`).
- `server.ts` code that must call the engine has no credential helper yet —
  parse `service.json` by hand (node builtins only, no core imports); a
  `ctx.engine` helper is the planned fix (`server/ext/types.ts`).

## Loading lifecycle (where an extension travels)

One folder becomes pixels through four files — follow them in order:

1. **Glob (shipped, repo dev).** `webui-extensions/index.ts` globs
   `./*/index.{ts,tsx}` and tracks each module's `export const id` (Vite
   HMR path — edits hot-swap via same-id registry swap, deletions prune
   owned ids only).
2. **Discovery (proxy).** `server/userExtensions.ts`
   (`discoverUserUIEntries`) scans the three sources highest-precedence
   first — user root, project root, shipped dir — taking the folder id
   from `manifest.json` (`id`, falling back to the dir name) and the
   entries from `index.tsx`/`dom.ts`. Same id at a lower source is
   skipped with a once-per-process `shadowed` warning.
3. **Manifest + SSE + bundling (proxy).** `server/index.ts` merges folder
   entries with engine-plugin UI halves, serves
   `GET /api/webui/extensions` (`{ id, url?v=mtime, domUrl?v=mtime,
   source, origin }`), pushes a `{ type: "webui.extensions", version }`
   event per manifest change on `GET /api/webui/extensions/events`, and
   bundles each entry standalone with `Bun.build` (`bundleUIEntry` —
   react external, build logs printed loudly, never silent).
4. **Import + register (page).** `src/lib/runtimeExtensions.ts` fetches
   the manifest, dynamic-imports each new `?v=` bundle (re-import on
   mtime move → dispose the old instance → registry same-id-swap → live
   repaint), runs the module's `activate(ctx)` entry when present, mounts
   `domUrl` via the DOM kit, and disposes + unregisters ids that vanish or
   flip `disabled: true`. Shipped browser bundles are skipped here (the glob
   owns them — importing twice would run side effects twice) but shipped
   `domUrl` still mounts and `disabled` still pauses them.

## What extensions can use (browser stratum)

Everything the app can — shipped extensions are the same build:

- the curated store facade (`store` / `ctx.store`), or `useStore` directly in
  shipped components
- declared settings (`ctx.settings` / `settings.forExt(id)`) — core renders and
  persists the manifest schema
- other extensions' contributions and the peer bus
  (`ctx.collections` / `ctx.bus`)
- `api` from `src/api/client.ts` (every endpoint fires `api.pre/post/error`)
- the event bus (`ctx.on` / `events.subscribe`) — raw engine events + derived
  lifecycle events, frame-batched
- `getService` / services from `src/extensions/registry.tsx`
- UI primitives from `src/components/ui/` (shadcn) — always build on these
  so extensions look native
- Design tokens in `src/styles.css` as `var(--...)` — never hardcode colors
- Toaster via the extension API surface (`notify`)

External (user/project-dir) extensions use the one extension API surface
(`register`, `react`, `api`, `store` facade, `events`, `settings`,
`collections`, `bus`, `prefs`, `notify`, `services`, `dom` kit, `kv`,
`advanced.*` raw modules) — used identically by our shipped ones.

## Hot reload guarantees

- **Browser extensions (external dirs):** the proxy watches all three
  sources, rebuilds changed bundles, bumps the `?v=` version, and pushes the
  manifest over SSE (`GET /api/webui/extensions/events`); the page
  re-imports the bundle (browser ESM cache-busts on the query) and the
  registry same-id-swaps → live repaint, sub-second. Replaces the old 8s
  poll. Delete/move = uninstall (the id vanishes from the manifest);
  `disabled: true` = paused.
- **Browser extensions (repo dev):** Vite HMR — same folder format, same
  API; only the transport differs.
- **Proxy extensions:** no proxy restart for code edits (stat-poll +
  cache-busted re-import; dispose stops the old module's pollers first).
- **Engine payload:** engine rules apply (see above).

## Worked example — the timestamp test (choosing the right stratum)

> User tweaks only the timestamp format. Maintainer later redesigns the
> token counter and adds a finish badge in the same header. **The user gets
> both, visibly** — parent and siblings are still core's; the user's wrap
> delegates by default. (`docs/extension-system-spec.md` §5.4.)

```tsx
// ✅ RIGHT — wrap (stale-proof): the header redesign flows through
register({
  kind: "wrap", id: "my-time-wrap", target: "Timestamp",
  render: (props, next) => <span className="tabular-nums">{next()}</span>,
});
// ✅ RIGHT — service (surgical): only the format string is yours.
// NOTE: one entry per id — same-id re-register SWAPS, so this needs its
// own id or it evicts the wrap above.
register({
  kind: "service", id: "my-time-format", service: "format.timestamp",
  value: (iso: string) => new Date(iso).toLocaleTimeString(),
  precedence: 10,
});
// ⚠️ OWNERSHIP — replace: you freeze the timestamp; core redesigns stop here
register({
  kind: "replace", id: "my-time-own", target: "Timestamp",
  render: (props, core) => <MyClock {...props} />,
});
// ❌ WRONG STRATUM — dom.ts for a registered unit: outside the contract,
//    breaks silently on the redesign. DOM is for portals/canvas/iframes.
```

## Sandbox (iterate without touching the user's webui)

`bunx opencode-webui sandbox` (or `bun run sandbox` in a checkout) starts an
isolated second instance — loopback-only `127.0.0.1:4099`, passwordless (the
bind address is the guarantee), same engine/sessions, extensions from an
isolated scratch dir (`WEBUI_EXTENSION_DIR`,
default `~/.local/state/opencode-webui/sandbox-extensions/`).
`WEBUI_EXTENSION_DIR` is a higher-precedence ADD, not a replace: it swaps
out the user + project roots only — shipped extensions still load
underneath, and a same-id scratch folder shadows the shipped copy (the
`shadowed` log line is the only signal). Iterate there; "shipping" =
copying the folder into the real extension dir.

### Parallel sandboxes (agents: read this)

Yes — run as many sandboxes at once as you need, one per extension under
test. `bun run sandbox` stacks with no flags: the first instance takes the
fixed defaults (`:4099`/`:5175` + shared scratch dir); every further
instance detects the busy ports and auto-isolates onto free ports + a fresh
mkdtemp extension dir, printing exactly what it picked. Explicit env
(`WEBUI_PROXY_PORT` / `WEBUI_VITE_PORT` / `WEBUI_EXTENSION_DIR`) always wins
per knob and disables that knob's auto behavior.

Rules: one sandbox per extension, never two writers to one ext dir, never
reuse a port. The engine stays shared (same sessions everywhere, by
design) — only ports + extension dirs are isolated. Sandbox instances are
loopback-only and passwordless; the bind address is the guarantee.
