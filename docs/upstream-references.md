# Upstream references — what they are and how we use them

Local checkouts of `anomalyco/opencode` kept **outside** this repo (reboot-safe,
never committed here). Read-only reference material: mine them for behavior,
patterns, and API truth. Never copy code wholesale (MIT, but our dependency
rules still apply: patterns yes, packages/deps no).

| Checkout | Path | Contents |
| --- | --- | --- |
| current `dev` branch | `~/opencode-reference/` | v2 engine + TUI + hybrid web app |
| tag `v1.18.9` | `~/opencode-reference-v1/` | legacy TUI + legacy web app |

Refresh with `git -C ~/opencode-reference pull` (default branch is **`dev`**;
there is no `main`). Re-cloning from scratch also works:
`git clone --depth 1 https://github.com/anomalyco/opencode <dir>`.

## What each thing is good for (ranked)

### 1. `packages/session-ui/` — shared chat surface
Components/context (`components/`, `context/`, `v2/`, `styles/`) that render
sessions/messages across upstream surfaces. **Use for:** behavioral spec of
conversation rendering — part ordering, streaming projections, tool call UI —
when polishing our `Conversation`/`MessageItem`.

### 2. `packages/app/src/context/server-session-v2-reducer.ts` (+ `global-sync/event-reducer.ts`)
Upstream's v2-event→UI-projection logic. **Use for:** cross-checking our
`src/store.ts` `handleEvent` reducer on edge cases — dedup, part identity,
reconciliation, settle semantics. When something streams weirdly for us, see
how the official client models the same events.

### 3. `packages/sdk/js` + `packages/client` — authoritative API types
Generated typed models for the server API. **Use for:** diffing our
`src/api/types.ts` contract layer. Pairs with our own snapshot
(`docs/reference/openapi.json`, refresh via `bun run scripts/fetch-openapi.ts`).

### 4. `packages/tui/src/` — the v2 TUI (React)
Dialogs (`dialog-model.tsx`, `dialog-session-list.tsx`,
`dialog-theme-list.tsx`, …), prompt editor, command palette, routes.
**Use for:** behavioral spec when a request says "like the TUI" — e.g. picker
behavior, palette UX, session management flows.

### 5. `V1_API_MIGRATION.md` (in `packages/app/`) — v2 event model map
Their checklist migrating the legacy web app to v2 APIs/events, naming exact
legacy→v2 event replacements and file paths. **Use for:** understanding the v2
event vocabulary and what replaced what when debugging event handling.
(We are NOT migrating anything — we were v2-native from day one.)

### 6. Long tail
- `packages/app/e2e/` — Playwright specs documenting expected user flows.
- `packages/ui/` — original design-token source (already distilled into our
  `src/styles.css`; gap-check only).
- `packages/storybook/` — component gallery, if visual comparison is needed.
- `packages/app/AGENTS.md` + root `AGENTS.md` — upstream's engineering
  conventions; useful context when reading their code (e.g. benchmark-before-
  touching-timeline, i18n discipline).

## Verified findings (2026-08-21, live test against our service)

1. **Upstream's web app does NOT work against our pure-v2 deployment.**
   It is officially *hybrid* (their words): partially on `/api/*`, still
   consuming legacy events (`session.status/idle/error`, `message.part.delta`
   — unchecked boxes in `V1_API_MIGRATION.md`) and a project-centric data model.
   Observed: renders fine, auths fine, zero console errors, but sees NO
   sessions/projects and "New session" is inert. Our v2-native build is NOT
   duplicating released work.
2. **No UI extensibility upstream.** No slots, no registry; `app/src/addons/`
   is just serialization helpers. Monorepo `packages/plugin` is ENGINE-side.
   Our `webui-extensions` extension system has no equivalent there.
3. **The app is SolidJS**, not React. Patterns transfer; code does not.
4. **Auth**: the local service speaks Basic auth (`opencode:` +
   password from `~/.config/opencode/service.json`). Their app accepts an
   `?auth_token=` URL param holding base64 `user:pass`. Our proxy exists so the
   browser never holds credentials — upstream has no such story.

## How to launch upstream's web app (for inspection)

```
cd ~/opencode-reference && bun install        # ~12s, 4.7k packages
cd packages/app
VITE_OPENCODE_SERVER_HOST=127.0.0.1 \
VITE_OPENCODE_SERVER_PORT=<service port> \
  bun run dev -- --port 4444
# open http://localhost:4444/?auth_token=$(echo -n "opencode:<password>" | base64)
```

Service port is dynamic — get it via our proxy: `curl -s
http://127.0.0.1:4097/api/webui/status` (field `service`).
