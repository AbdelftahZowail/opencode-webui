# UI Extensions

Frontend additions live in `ui-extensions/<name>/` and are **plain React
code, compiled into the app** — no plugin framework, no manifests, no dynamic
loading. This is a deliberate choice: extensions keep full type safety, hot
reload, and complete access to the app (store, API client, components).

## The kind contract (stable API)

Extensions register **kinds** via `register()` from `src/extensions/registry.tsx`.
This list is versioned — the app only breaks an extension when a kind is
deliberately changed. Every kind is gated per-id by `enabled` in `ui-extensions/config.ts`
(ancestry-aware: `my-ext.sub` is on when `my-ext` is enabled).

| Kind | What it does | Where it surfaces |
| --- | --- | --- |
| `region` | render into any `<Slot region="…">` marker placed by core (see generated table below) | wherever core placed a `<Slot>` |
| `command` | entry in the palette's "Extension commands" group (`run({ sessionID })`; `keybind` like `ctrl+shift+k` for global hotkey) | command palette (⌘/ctrl-K) + keybind |
| `slash` | **UI-only** slash entry for Composer `/name` (local `run(args,{sessionID})`; not engine) | Composer autocomplete (`/` menu) |
| `message` | full replacement for any message type (`type:"system"\|"synthetic"\|"shell"\|"compaction"\|"user"\|"assistant"\|…\|"*"`, `render({message, sessionID}) => node\|null`); first non-null wins, else core `renderMessageBody` | `MessageItem` per message |
| `message.decoration` | small extras under message rows; `render({ messageID, message }) => node\|null` | under every message row |
| `message.part` | inject after *each* part (text/tool/reasoning) inside a message; `render({messageID, message, part, partIndex})` | inside `MessageItem` per part |
| `tool.renderer` | custom card for a specific tool name (`toolName:"bash"\|"edit"\|…`, `render(part)`) | `ToolCard` per tool call |
| `contextMenu` | right-click menu item (`target:"message"\|"session"\|"file"`, `label`, `run`, `order`) | context menu |
| `hook` | intercept/behavior (`event:string`, `handler(ctx,next)`) — see Hook events below | store / Composer / MessageItem |
| `page` | full surface at `/ext/{id}` (route derived from the id) | sidebar links + direct URL |
| `settings` | titled section inside Settings › Extensions (`render: () => ReactNode`) | Settings dialog |

Reference implementation of every kind was `ui-extensions/dev-sandbox/` (removed — clean launch; see git history for numbered examples).

### Hook events

`hook` is open — `event` is a `string`, known values are versioned but you can
register any string and core will call `getHooks(event)` at the seam when it
exists. Today:

| Event | `ctx` shape | When |
| --- | --- | --- |
| `session.prompt` | `{ text: string, sessionID: string }` — mutate `ctx.text` to transform; call `next()` to continue | Composer `submit` before `POST /api/session/{id}/prompt` |
| `message.render` | `{ message: MessageInfo, sessionID?: string }` — mutate `ctx.message` (shallow clone) before render | `MessageItem` before `message` renderer |
| `store.dispatch` | `{ action, ... }` | store middleware observer |

Adding a new seam (e.g. `composer.submit`, `tool.started`) is one `getHooks("new.event")` call in core — no registry bump for existing extensions.

### Slash: engine vs UI

Composer's `/` menu `src/components/Composer.tsx:576` is a merge:

1. **UI built-ins** `slashActions[]` `Composer.tsx:403` (`/new`, `/undo`, `/thinking`… — local, never hits engine)
2. **UI extensions** `kind:"slash"` `registry.tsx:62` (`/bench` → local `run(args,{sessionID})`)
3. **Engine** `GET /api/command` + `GET /api/skill` `src/api/client.ts:677` (`commands`/`skills` → `POST /api/session/{id}/command`)
4. Sorted + fuzzy `filterSlashEntries` `Composer.tsx:125`, capped `SLASH_MENU_LIMIT=10`.

* Want `/` to run **on the server** (tool, agent work)? Add an **engine plugin** (provides `Command`/`Skill` via `GET /api/plugin` — engine docs). It appears automatically, no UI change.
* Want `/` to run **locally in the UI** (toggle panel, run `api.*`, `useStore` action, `notify()`)? Use `kind:"slash"` in a UI extension. Keep the name `^[a-z0-9_-]+$`; on clash engine wins (UI extension warns and is skipped).

Palette `kind:"command"` stays the place for `⌘K` actions; `kind:"slash"` is only for the `/` autocomplete.

## Anatomy of an extension

```
ui-extensions/
  index.ts          ← auto-discovery: every <name>/index.{ts,tsx} is loaded,
                      no manual imports (visibility gated by config.ts)
  hello/
    index.tsx       ← registers against one or more kinds
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
  kind: "region",
  id: "hello",
  region: "footer",
  render: () => <span>Hello!</span>,
});
if (import.meta.hot) import.meta.hot.accept();
export const id = "hello";
```

A tool renderer receives the full tool part:

```tsx
register({
  kind: "tool.renderer",
  id: "my-bash-card",
  toolName: "bash",
  render: (part) => <pre>{part.state.content}</pre>,
});
```

A UI-only slash:

```tsx
register({
  kind: "slash",
  id: "my.slash",
  name: "bench",
  description: "Run bench locally",
  aliases: ["b"],
  run: (args, { sessionID }) => console.log("bench", args, sessionID),
});
```

A message replacement (own `system`/`synthetic` without touching core):

```tsx
register({
  kind: "message",
  id: "my.instructions",
  type: "system",
  render: ({ message }) => {
    // return null to fall back to core's InstructionCard
    if (!String((message as any).text ?? "").includes("The Code Mode tool catalog")) return null;
    const title = (message as any).description ?? "Instructions updated";
    return <div className="rounded-md border px-3 py-1.5 text-xs">{title}</div>;
  },
});
```

## What extensions can use

Everything the app can — it's the same build:

- `useStore` / store actions from `src/store.ts` (session state, sending prompts, permissions, `selectSession`, `sendPromptTo`, `interrupt`, …)
- `api` from `src/api/client.ts` (any endpoint: `listSessions`, `messages`, `fsRead`, `shellCreate`, …)
- `window.__opencodeUI.notify({title, description, variant})` — toasts (also `import {notify} from "../../src/lib/notify"` in built-ins)
- `window.__opencodeUI.getHooks` — inspect registered hooks (runtime bridge)
- UI primitives from `src/components/ui/` (shadcn: `Button`, `Dialog`,
  `DropdownMenu`, `Command`, `Tooltip`, `ContextMenu`, …) — always build on these so
  extensions look native
- The OC-2 design tokens in `src/styles.css` — consume as
  `var(--background-base)`, `var(--text-weak)`, `var(--border-base)`, etc.
  **Never hardcode colors**; tokens keep extensions theme-compatible
- Any component, hook, or CSS class
- Right-click menus and per-part injections need no extra setup — just register `contextMenu`/`message.part` kinds.

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
register({ kind: "region", id: "status-bar", region: "footer", render: () => <StatusBar /> });
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
| `app.header` | `src/App.tsx:238` |
| `composer.above` | `src/components/Composer.tsx:932` |
| `composer.below` | `src/components/Composer.tsx:1252` |
| `composer.toolbar` | `src/components/Composer.tsx:1240` |
| `footer` | `src/App.tsx:303` |
| `header.session.actions` | `src/components/Conversation.tsx:572` |
| `header.session.before` | `src/components/Conversation.tsx:520` |
| `message.after` | `src/components/MessageItem.tsx:258` |
| `message.before` | `src/components/MessageItem.tsx:239` |
| `sidebar` | `src/components/Sidebar.tsx:682` |
| `sidebar.session.after` | `src/components/Sidebar.tsx:982` |
| `sidebar.session.before` | `src/components/Sidebar.tsx:914` |
| `tool.after` | `src/components/ToolCard.tsx:58` |
| `tool.before` | `src/components/ToolCard.tsx:57` |
| `transcript.above` | `src/components/Conversation.tsx:128` |
| `transcript.below` | `src/components/Conversation.tsx:155` |
| `transcript.empty` | `src/components/Conversation.tsx:434` |
<!-- regions:auto:end -->

Run `bun run regions` after adding a `<Slot region="…">` in core — the table is auto-generated.

## Limitations & when to use what

Extensions are **not a second engine**. These stay engine-owned:

| Area | UI extension can do | Engine plugin must do |
| --- | --- | --- |
| Slash that runs on server | Show it as UI-only `kind:"slash"` but it won't hit `POST /api/session/{id}/command` | Provide `Command`/`Skill` via engine plugin (`GET /api/plugin` → `GET /api/command`) |
| New tool that the model can call | Render it differently via `kind:"tool.renderer"` | Provide the tool itself (engine `Tool` + execution) |
| New permission/form/question kind | Render extra decoration, auto-reply via `api` + `hook:store.dispatch` observer | Define it on engine |
| Session/model/agent lifecycle | Read/trigger via `useStore`/`api` | Own it |

**No snooping needed:** if a region/kind isn't in the tables above, it doesn't exist. Adding a region is one line `<Slot region="area.thing" />` in core + `bun run regions`; adding a kind is a deliberate contract change in `src/extensions/registry.tsx` (+ docs here + `src/extensions/registry.tsx:5` header + `AGENTS.md`). Don't invent speculative kinds — add a `region` first.

**What you don't need to fork core for anymore:**

* Verbose `Instructions updated` / catalog dump `src/components/MessageItem.tsx:268` → `kind:"message"` `type:"system"|"synthetic"` with `return null` fallback
* Per-session badges / cost / PR status `src/components/Sidebar.tsx:892` → `region:"sidebar.session.before/after"` with `sessionID` ctx
* Extra header buttons `src/components/Conversation.tsx:518` → `region:"header.session.before/after"`
* Composer buttons next to `Send` `src/components/Composer.tsx:1238` → `region:"composer.toolbar"`
* Wrapping a tool or message `src/components/ToolCard.tsx:29` → `region:"tool.before/after"` / `region:"message.before/after"` or `kind:"message"` / `kind:"tool.renderer"` for full replacement
* Intercepting a prompt `src/components/Composer.tsx:727` → `hook:"session.prompt"` mutate `ctx.text`; observing renders → `hook:"message.render"` mutate `ctx.message`

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
