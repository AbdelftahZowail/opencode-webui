# UI Extensions

Frontend additions live in `ui-extensions/<name>/` and are **plain React
code, compiled into the app** — no plugin framework, no manifests, no dynamic
loading. This is a deliberate choice: extensions keep full type safety, hot
reload, and complete access to the app (store, API client, components).

## The kind contract (stable API)

Extensions register **kinds** via `register()` from `src/extensions/registry.tsx`.
This list is versioned — the app only breaks an extension when a kind is
deliberately changed.

| Kind | What it does |
| --- | --- |
| `region` | render into any `<Slot region="…">` marker placed by core (see generated table below) |
| `command` | entry in the palette's "Extension commands" group (`run({ sessionID })`; palette or `keybind` like `ctrl+shift+k`) |
| `message.decoration` | small extras under message rows; `render({ messageID, message }) => node \| null` |
| `message.part` | inject after *each* part (text/tool/reasoning) inside a message; `render({messageID, message, part, partIndex})` |
| `contextMenu` | right-click menu item (`target: "message"\|"session"\|"file"`, `label`, `run`, `order`) |
| `hook` | intercept/behavior (`event: "session.prompt"\|"store.dispatch"\|"message.render"`, `handler(ctx,next)`) — mutate prompt text, observe dispatches |
| `page` | full surface at `/ext/{id}` (route derived from the id); listed in the sidebar when registered |
| `tool.renderer` | custom card for a specific tool name |
| `settings` | titled section inside Settings › Extensions (`render: () => ReactNode`) |

Legacy `{ id, slot: "sidebar" \| "footer" \| "composer.replace", render }`
registrations still work — they normalize onto regions internally
(`extension.sidebar` / `extension.footer` / `composer.replace`).

Reference implementation of every kind: `ui-extensions/dev-sandbox/`.

## Region markers

Drop-in render points addressed by string. Empty regions cost nothing;
register against one with `{ kind: "region", region: "...", render }`.

## Anatomy of an extension

```
ui-extensions/
  index.ts          ← auto-discovery: every <name>/index.{ts,tsx} is loaded,
                      no manual imports (visibility gated by config.ts)
  hello/
    index.tsx       ← registers against one or more slots
  my-feature/
    index.tsx
    components.tsx  ← anything else; it's just your code
```

`ui-extensions/index.ts` is the only thing the app imports; each extension
folder self-registers:

```tsx
// ui-extensions/hello/index.tsx
import { register } from "../../src/extensions/registry";

register({
  id: "hello",
  slot: "footer",
  render: () => <span>Hello!</span>,
});
```

A tool renderer receives the full tool part:

```tsx
register({
  id: "my-bash-card",
  slot: "tool.renderer",
  toolName: "bash",
  render: (part) => <pre>{part.state.content}</pre>,
});
```

## What extensions can use

Everything the app can — it's the same build:

- `useStore` / store actions from `src/store.ts` (session state, sending prompts, permissions)
- `api` from `src/api/client.ts` (any endpoint)
- `window.__opencodeUI.notify({title, description, variant})` — toasts (also available as `import {notify} from "../../src/lib/notify"` in built-ins)
- `window.__opencodeUI.getHooks` — inspect registered hooks (runtime bridge)
- UI primitives from `src/components/ui/` (shadcn: `Button`, `Dialog`,
  `DropdownMenu`, `Command`, `Tooltip`, `ContextMenu`, …) — always build on these so
  extensions look native
- The OC-2 design tokens in `src/styles.css` — consume as
  `var(--background-base)`, `var(--text-weak)`, `var(--border-base)`, etc.
  **Never hardcode colors**; tokens keep extensions theme-compatible
- Any component, hook, or CSS class
- Hooks: `register({kind:"hook", event:"session.prompt", handler:(ctx,next)=>{ ctx.text = "modified"; next() }})` to intercept prompts/dispatches.
  Right-click menus and per-part injections need no extra setup — just register `contextMenu`/`message.part` kinds.

## Add / remove / disable

| Action | How |
| --- | --- |
| Add | Create `ui-extensions/<name>/`, add one import to `ui-extensions/index.ts`. Appears instantly via HMR. |
| Remove | Delete the import line and the folder. |
| Disable | Remove its id from the `enabled` list in `ui-extensions/config.ts` — one line, applies instantly via HMR, no reload. |

The `enabled` list in `ui-extensions/config.ts` is the runtime switch: only
ids listed there are rendered, even if the code is bundled. (A settings-panel
UI could drive the same list later — the mechanism is already in place.)

## Sharing with others

An extension is a React component, so npm is the sharing format:

```bash
bun add @someone/opencode-webui-status-bar
```

```tsx
// ui-extensions/index.ts
import { register } from "../src/extensions/registry";
import { StatusBar } from "@someone/opencode-webui-status-bar";
register({ id: "status-bar", slot: "footer", render: () => <StatusBar /> });
```

That's it — no plugin API to learn, nothing to build. Publishing a shared
extension is just publishing a component library.

## Preview before production

The dev server (localhost:5173) is the preview: every edit hot-reloads there,
and production (the built app on 4097) only changes when you run
`bun run build && bun start`. For a second, isolated preview page of WIP
changes, run `bun run preview` (localhost:5174, proxy :4098).

### Hot reload

Extension entries end with `if (import.meta.hot) import.meta.hot.accept();` and
export their `id` — keep both. Editing an extension hot-swaps it live (same-id
registry swap, slots repaint); ADDING a folder is hot too (`index.ts`
re-discovers without a reload). DELETING a folder still costs one coalesced
full reload — Vite can't re-fetch a deleted module, so removing an extension
is the one lifecycle step that reloads. Flipping `config.ts` also reloads.
Slots removed by an edit disappear cleanly on that next reload.

## Region markers

Drop-in render points addressed by string. Empty regions cost nothing;
register against one with `{ kind: "region", region: "...", render }`.

<!-- regions:auto:start -->
| Region | Render point |
| --- | --- |
| `composer.above` | `src/components/Composer.tsx:872` |
| `composer.below` | `src/components/Composer.tsx:1177` |
| `footer` | `src/App.tsx:298` |
| `header.session.actions` | `src/components/Conversation.tsx:540` |
| `message.after` | `src/components/MessageItem.tsx:70` |
| `sidebar` | `src/components/Sidebar.tsx:512` |
| `transcript.above` | `src/components/Conversation.tsx:100` |
| `transcript.below` | `src/components/Conversation.tsx:124` |
| `transcript.empty` | `src/components/Conversation.tsx:403` |
<!-- regions:auto:end -->

## Runtime plugin extensions (plugin-shipped UI)

An opencode v2 plugin can carry a WEB UI half that this app loads at runtime —
no webui rebuild, ever.

**Convention**: for a plugin whose entry is `<dir>/foo.ts`, the UI entry is
`<dir>/ui/main.tsx` (or a sibling `<dir>/foo.ui.tsx`). Only plugins loaded
from LOCAL sources (`Plugin.Source {type:"local"}`) are discovered in v1;
npm-package plugins would need node resolution and are future work.

**Pipeline**: `GET /api/plugin` (engine) → proxy finds UI entries →
`Bun.build` bundles each entry as a SELF-CONTAINED ES module (it bundles its
own React copy) → served at `/api/webui/extensions/{id}/bundle.js?v=mtime`.
The page lists them from `GET /api/webui/extensions`, allow-lists their ids in
the registry, and `import()`s each bundle. Bundles reach the app ONLY through
the `window.__opencodeUI` bridge (`{ version, register, react, jsxRuntime,
useStore, api }`) — that object is the versioned public API for runtime
extensions; deep internal imports are not available to them.

**Gating**: default ON (installing the plugin means you wanted it). Toggle any
of them in Settings › Extensions — persisted per browser, applies within one
poll cycle (~8s; off = unregistered immediately). Built-in `ui-extensions/`
are not listed there; they stay gated by `config.ts`.

**Talking to the engine half**: the UI half and the engine half of a plugin
communicate through the engine's normal HTTP/SSE surface — call routes via
`api`, subscribe to events via the store's SSE connection, exactly like core.
