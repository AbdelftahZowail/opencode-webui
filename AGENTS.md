# opencode-webui

A web frontend for the **OpenCode v2 engine**. The engine is a separate
background service; this project is only a client of its HTTP API. The UI side
is deliberately dependency-light (React + Vite, no plugin *framework* — but our
own 4-stratum **extension system**, below). Hot reload everywhere.

**Docs tree:** `docs/README.md` is the index. This file is the law and the
router — architecture, the rules you must not break, and *where to look*. Deep
explanation lives in `docs/`; see "Where to look" at the bottom.

## Architecture

```
browser ──/api──> Bun proxy server (server/index.ts) ──auth──> opencode service
   ▲                                                              (owns sessions,
   └────────── dist/ served by the proxy in production           agents, tools)
```

- **The browser never holds service credentials.** The proxy discovers the
  service and attaches auth. Do not bypass the proxy.
- **Dev**: `bun run dev` starts the dev proxy (4098, `WEBUI_PROXY_PORT`) + Vite
  (5173, `WEBUI_VITE_PORT`); Vite proxies `/api` to the dev proxy. The dev proxy
  avoids the configured serve `port` (4097, owned by the production server +
  lifecycle plugin) so `bun run dev` and `bun start` never collide. Vite binds
  the config `host` and honors `allowedHosts`; sandbox always forces its Vite
  child back to loopback. HMR applies instantly — no refresh, no restart, and
  the opencode service is never restarted.
- **Sandbox**: `bun run sandbox` starts a SECOND instance on `127.0.0.1:4099` —
  loopback-only, passwordless, attaches to the running engine, loads extensions
  from an isolated scratch dir (`WEBUI_EXTENSION_DIR`). In a repo checkout it
  also runs Vite (5175). Iterate extensions there; shipping = copying the folder
  into the real extension dir.
- **Prod**: `bun run build && bun start`; the proxy serves `dist/` + the API on
  4097.

Engine endpoint resolution is **discovery-first, single-flight, breakered**
(`server/engineResolver.ts`) with a spawn-free **registration fallback**
(`server/engineDiscovery.ts`) so a drifted engine degrades feature-by-feature
instead of bricking the proxy. The API-sync scripts share that module. Explicit
`WEBUI_ENGINE_URL` wins and skips discovery/ensure entirely.

## Where things live

| Path | Purpose |
| --- | --- |
| `server/index.ts` | Bun proxy: auth, `/api/*` passthrough, static serving, event recorder + browser SSE fan-out |
| `server/engineResolver.ts` | Discovery-first, single-flight, breakered engine resolver |
| `server/engineDiscovery.ts` | Spawn-free discovery + the registration fallback (shared by the proxy and the API-sync scripts) |
| `server/shelf.ts` | Core file shelf: read-only, auth-gated, traversal-proof serving + listing (`/api/shelf/*`) |
| `server/shelfEnginePlugin.ts` | Embedded engine payload installing the `shelf_share`/`shelf_list`/`shelf_remove` tools + system hint |
| `src/api/types.ts` | All API schemas — copy from the service's `/openapi.json` (the contract) |
| `src/api/client.ts` | Typed REST client (one function per endpoint) |
| `src/api/events.ts` | SSE parser for `/api/event` + reconnection + watchdog |
| `src/lib/scheduler.ts` | The one fetch/tick scheduler — tiers (live/idle/hidden), registered pollers, no component-owned `setInterval` |
| `src/store.ts` | Central state: sessions, messages, live streaming, permission/form queues, event reducer |
| `src/components/` | UI: `Sidebar`, `Conversation`, `MessageItem`, `ToolCard`, `Composer`, `Pickers`, `RunsPanel`, `QueueStrip`, `PendingRequestsPanel`, `ui` (primitives) |
| `src/components/markdown/` | Core markdown pipeline: single memoized ReactMarkdown mapping — `Table.tsx`, `PreviewBlock.tsx` (tilde-fence live previews), `ShelfChip.tsx` |
| `src/components/shelf/` | Shelf browse page + inline media preview components |
| `src/extensions/registry.tsx` | The extension registry (v2 contract: kinds, target chains, collections, services, hooks — do not change lightly) |
| `src/extensions/context.ts` | Activation lifecycle: `activate(ctx)` entry + disposal; the `ctx` surface (poll/after/on/subscribe/store/settings/collections/bus) |
| `src/extensions/manifest.ts` | Manifest contract: `settings` schema + `requires` parse/resolve/check |
| `src/extensions/slots.tsx` | Thin slots: `SLOT_IDS` + the `<Slot>` placement renderer (`data-oc-slot`) |
| `src/extensions/hooks.ts` | Shared `fireHooks` runner for `kind:"hook"` extensions (open event strings) |
| `src/lib/domKit.ts` | DOM-stratum kit (`foreign`/`watch`/`styles`, mount/dispose, `data-oc-*` anchors) |
| `src/lib/eventBus.ts` | The extension event bus (raw engine events + derived lifecycle), frame-batched |
| `src/lib/storeFacade.ts` | The curated store surface extensions get as `store` (raw module = `advanced.store`) |
| `src/lib/extSettings.ts` | Per-extension declared settings: schema registry, resolve, persist, subscribe |
| `src/lib/extBus.ts` | Extension-to-extension peer bus (`publish`/`subscribe`, many-to-many) |
| `src/lib/extensionApi.ts` | The ONE extension API surface (bridge): `window.__opencodeUI` / `getExtensionApi()` + `EXT_API_VERSION` |
| `src/lib/runtimeExtensions.ts` | Browser loader client: manifest fetch + SSE push, bundle import, same-id swap |
| `src/lib/modelCatalog.ts` | Shared prefetched model catalog (one fetch, subscribers, loading/error states) |
| `src/lib/modelMemory.ts` | New-session model memory: pinned default, last-used, recents + resolution cascade |
| `server/ext/` | Proxy-stratum loader + mount points (`routes`, `middleware`, `onEvent`, `pollers`, KV) |
| `server/userExtensions.ts` | Browser-stratum folder discovery: one loader, three sources, manifest gating |
| `server/setup.ts` | First-run setup: global command, managed engine plugins, launch handoff, pidfile; CLI (`update`/`stop`/`restart`/`uninstall`) |
| `server/lifecyclePlugin.ts` | The built-in OpenCode lifecycle plugin source — starts the proxy when the engine loads |
| `server/config.ts` | Serve/security config + `config` CLI |
| `server/telemetry.ts` | Anonymous usage heartbeat: opt-out, release-gated, fail-open; the wire allowlist (see `docs/reference/telemetry.md`) |
| `server/notices.ts` | Product notices: cached, fail-open proxy read of the hub's public announcement + version feeds (see `docs/reference/notices.md`) |
| `src/components/settings/AccessSection.tsx` | Settings › Security UI. Settings has seven tabs: Extensions, Plugins, Notifications, Security, About, Appearance, Shell (+ App on phone) |
| `webui-extensions/` | Shipped extensions (one folder per extension). Authoring guide: `webui-extensions/README.md` |
| `docs/` | The docs tree — index in `docs/README.md` |

## Rules for editing

1. **Never change the contract layer without the OpenAPI doc.** Before touching
   `src/api/types.ts` or `client.ts`, diff against the running service with
   `bun run scripts/diff-openapi.ts`; refresh with `bun run scripts/fetch-openapi.ts`
   (writes `docs/reference/openapi.json`). The full procedure is
   **`docs/runbooks/engine-update.md`**, and the route map is
   `docs/reference/coverage.md`. The snapshot was **re-synced on 2026-10-07** to
   the live engine (2.0.22): 116 paths / 255 schemas, and
   `bun run scripts/diff-openapi.ts --check` exits 0. Do NOT regenerate it as part
   of an unrelated fix — a re-sync is its own workstream, because it desyncs
   `types.ts` and every row of `coverage.md`. Prefer a narrow fix plus a dated
   scope note in `docs/reference/coverage.md`.
1a. **Generated files — don't hand-edit:** `docs/reference/openapi.json` (from
   `fetch-openapi.ts`) and `skills/webui/SKILL.md` + `skills/testkit/SKILL.md`
   (from `bun run gen:skill`, which extracts from `webui-extensions/README.md`
   and the testkit runbook; both are pinned to the `package.json` version).
   `dist/` and `release/` are gitignored build output.
2. **Keep the store as the only place state lives.** Components read via
   `useStore((s) => ...)` and call actions; they never fetch directly except for
   one-shot catalog data (`models`, `agents`, `commands`, `skills`). Recurring
   work goes through `src/lib/scheduler.ts` — no component-owned `setInterval`.
3. **Hot reload contract**: editing any file under `src/` applies immediately via
   Vite HMR. Full-page reloads are coalesced by `coalesceFullReload()` in
   `vite.config.ts` (~1s of filesystem quiet); root-level non-module files
   (`.md`, `docs/**`) aren't watched. Component files must export COMPONENTS ONLY
   — any runtime non-component export disables React Fast Refresh for the whole
   file. Editing `server/index.ts` restarts the proxy automatically
   (`bun run --watch`), which drops the SSE stream; it reconnects by itself.
   **Never restart the opencode service for UI work.**
4. **Styling** is Tailwind v4 utility classes, dark-first, consuming design
   tokens from `src/styles.css` as `var(--...)` — never hardcode hex. New
   components should not introduce new CSS.
5. **Keep it dependency-light.** React, react-markdown, shadcn/ui (vendored),
   Radix (vendored), lucide-react, and the Tailwind stack are the intended
   surface. Approved exceptions: `@shadcn/react` (headless MessageScroller),
   `@xterm/xterm` + addon-fit (PTY terminal emulator), and — for markdown
   fidelity, R1/R2 — `shiki` + `@shikijs/*`, `mermaid`, and `katex` (all
   lazy-loaded chunks). A new dependency needs justification.
6. **Adding a component or target?** Follow **`docs/runbooks/add-ui-surface.md`** —
   every new component self-registers and renders through its `<Target>`.
7. **Touching the extension system?** Follow **`docs/runbooks/add-extension.md`** —
   ids are contract, and the docs + version bump + skill move in the same commit.

## Extensions (one folder, four strata — read this before adding UI features)

One extension = **one folder** in one format, loaded by one loader, gated by
one rule. A folder may provide code in up to four *strata*
(full contract: `docs/reference/extension-system-spec.md` §4; authoring guide:
`webui-extensions/README.md`; agent skill: `skills/webui/SKILL.md`):

```
my-extension/
  manifest.json    id, name, version, description; optional disabled, settings, requires, capabilities
  index.tsx        browser stratum: register() and/or activate(ctx)
  dom.ts           DOM stratum: post-render DOM changes (the free layer)
  server.ts        proxy stratum: routes / middleware / event tap / pollers
  engine/          optional opencode plugin payload (tools, system-prompt hints)
```

| Stratum | Runs in | Reaches | One method |
|---|---|---|---|
| Browser (registry) | the page | React tree, store, api calls, logic modules | wrap / replace / contribute / hook / service |
| DOM | the page, post-render | any node incl. portals, canvas, iframes | `dom.ts` + the DOM kit (`src/lib/domKit.ts`) |
| Proxy | the proxy process | fs, spawn, engine creds, always-on event stream, all clients | `server.ts` + mount points (`server/ext/`) |
| Engine | the engine process | tools the model calls, system prompt | opencode plugin rules (out of scope — see `docs/reference/engine-payload-convention.md`) |

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
  (sub-second, no refresh). The fingerprint is **folder-wide** — the max mtime
  across the extension's source files. Repo dev uses Vite HMR. Proxy `server.ts`
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
>    guide, the spec, and the skill in the same commit. Code that outruns its docs
>    is a bug.
> 10. **The engine is out of scope.** We carry engine payloads and adapt client-side;
>     we do not reach into engine internals from the webui.

## Commands

- `bun run dev` — proxy + Vite with HMR
- `bun run sandbox` — isolated second instance: loopback-only, passwordless,
  scratch extension dir; dev mode adds Vite on 5175.
- `bun run typecheck` — `tsc --noEmit` (covers `src`, `server`, `scripts`, `webui-extensions`)
- `bun run build && bun start` — production build, served on 4097
- `bun run check:ext <extension-dir>` — no-browser pre-flight for an extension folder
  (manifest, entries, engine payload shape, bridge imports)
- `bun run gen:skill` — regenerate the shipped skills (`skills/*/SKILL.md`; runs in `prepublishOnly`)
- `bun run testkit:example` — real-client test harness: isolated engine + proxy
  driven through a real Chromium page and a real tmux TUI (`opencode-webui
  testkit example|run|list`; runbook `docs/runbooks/agent-testing.md`)
- `bun run check:setup` — global-wrapper + lifecycle-plugin + CLI contract, and a
  real plugin `setup()` spawn, in an isolated HOME/XDG tree; expect 51/0
- `bun run check:config` — serve/security config: resolution precedence,
  validation, password hashing/redaction, exposure, and the `config` CLI
- `bun run check:telemetry` — anonymous-telemetry contract: the payload
  allowlist, the forbidden-key/PII scan, release-gating, the `WEBUI_TELEMETRY`
  hard-kill, idempotent `seq`, and a static no-device-identity scan
  (`check:telemetry:live` POSTs a real payload to a hub)
- `bun run check:notices` — product notices: the proxy's hub read, fail-soft on
  an unreachable hub, the sanitizers, the pure selection/dismissal rules, and
  the rendered announcement/release-note markup (`check:notices:live` reads the
  real hub feeds)
- `bun run check:engine-guard` — the engine resolver's guards (spawn-free)
- `bun run check:swap` — is the engine's durable per-session log ready to replace
  the proxy recorder?
- `bun run check:unseen` / `check:unseen:dom` — the unseen/settle-slop checks
- `bun run scripts/uitest/*` — reusable UI/service checks (create/send/wait/messages,
  event-capture, catch-up proof, extension contract check)
- Extension battery (release gate for anything touching extensions), run in this order:
  `bun run scripts/uitest/ext-battery-browser.ts` (34) → `ext-battery-dom.ts` (10) →
  `ext-battery-proxy.ts` (17) → `ext-battery-acceptance.ts` (15) = 76/0.

Run the batteries **sequentially and alone** (a concurrent agent floods
`/api/event` and evicts the proxy tap ring → the `onEvent` test flakes). Any
assertion with a millisecond window must be proven **both ways** — reintroduce
the bug, watch the check go red, restore it — or the guard may be vacuous.

- Tests that start an engine: pin it with `WEBUI_ENGINE_URL` / `WEBUI_ENGINE_PASSWORD`
  (from the live `service.json`) and `WEBUI_NO_SETUP=1`, plus an isolated
  `XDG_CONFIG_HOME`/`XDG_STATE_HOME`, so nothing touches the global command or plugins.
- Never restart or respawn the running engine or the production webui to test.
- Scratch files: use the scratch dir the environment provides; `.uitest-*/` is gitignored.

## Packaging & CI

- npm tarball (`package.json` `files`) contains `dist/`, `server/`, `skills/`,
  `scripts/testkit/`, and `webui-extensions/README.md` — **no `src/`**. The server
  runs as TypeScript source under Bun. Verify packaging changes with
  `npm pack --dry-run`.
- `.github/workflows/release.yml` runs on `v*` tags: typecheck + build gate, then
  per-target binaries via `scripts/build-binary.sh`, attached to a GitHub release.

## Release

The release runbook is **`.opencode/release-helper.md`** (push + publish, every
step in order, plus the hard-won gotchas) — the **super-vibe** ship skill reads
that exact path. Follow it exactly — never publish without the tag.

## Contributing

`CONTRIBUTING.md` is the human entry point (dev setup, PR checklist). Keep
extension-system changes and unrelated changes in separate commits, and stage
explicit paths — never `git add -A`.

## Where to look (router — read before you act)

| If you are about to… | Read first |
| --- | --- |
| change the API contract, or the engine/API moved | `docs/runbooks/engine-update.md` |
| add or change a component / target / slot | `docs/runbooks/add-ui-surface.md` |
| touch the extension system (kind/id/service/hook/slot) | `docs/runbooks/add-extension.md` + `docs/reference/extension-system-spec.md` |
| plan or implement parity work | `docs/plans/parity.md` |
| work on extension seams | `docs/plans/extensions.md` |
| write an end-to-end test for a plugin/extension as a real user | `docs/runbooks/agent-testing.md` |
| check a route's status (have / client-only / gap) | `docs/reference/coverage.md` |
| understand the chat UI / streaming / rendering | `docs/reference/frontend.md` |
| work on first-run setup / the managed plugins | `docs/reference/setup.md` |
| deploy, reverse-proxy, auth/env, serve config | `docs/operations.md` |
| touch anonymous usage telemetry | `docs/reference/telemetry.md` |
| touch product notices / the notice surface | `docs/reference/notices.md` |
| ask "did we decide to skip X, or defer it?" | `docs/when.md` |
| check what the project is / isn't building | `docs/principles.md` |
| cut a release | `.opencode/release-helper.md` |
| orient in the docs at all | `docs/README.md` |
