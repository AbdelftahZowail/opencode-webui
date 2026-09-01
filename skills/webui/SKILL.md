---
name: webui
description: opencode-webui — the browser frontend for the OpenCode engine. Load when the user mentions the webui/web frontend, asks about webui extensions, or wants to report a webui bug (/report does it).
---

# OpenCode webui (opencode-webui)

The browser frontend for the OpenCode engine — same engine, same sessions as
the `opencode` TUI, with a Bun proxy in front so the browser never holds
service credentials. One port for UI + `/api/*`: http://localhost:4097
(`WEBUI_PROXY_PORT`).

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBUI_PASSWORD` | generated on first boot, printed once | Shared login passphrase. |
| `WEBUI_HOST` | `127.0.0.1` | Bind address — a wildcard is refused without a password. |
| `WEBUI_PROXY_PORT` | `4097` | Port for the UI and `/api/*`. |
| `WEBUI_DEBUG` | unset | `1` — server/proxy debug logs to stdout. |
| `WEBUI_DEBUG_LOG` | `/tmp/webui-debug.log` | File the frontend log sink (`POST /api/debug`) appends to. |

## What you can do for the user

- **File a webui bug** — the composer ships a built-in `/report` command that
  bundles diagnostics (build version, user agent, enabled extension ids, error
  ring) into a prefilled GitHub issue for AbdelftahZowail/opencode-webui (see
  Reporting bugs below).
- **Explain the extension system** from the tables below — they are extracted
  verbatim from the authoring guide (`ui-extensions/README.md`), which is the
  source of truth.
- **Author a user-dir extension** for the user — a folder, no build step, no
  restart.

### Minimal user-dir extension

Drop a folder — `~/.config/opencode/webui-extensions/<name>/main.tsx`
(per-user) or `<project>/.opencode/webui-extensions/<name>/main.tsx`
(per-project). The proxy bundles it and the page loads it within a poll cycle
(~8s); toggle per extension in Settings › Extensions. Runtime extensions reach
the app ONLY through the versioned `window.__opencodeUI` bridge (`register`,
`react`, `useStore`, `api`, `notify`, `getHooks`):

```tsx
// ~/.config/opencode/webui-extensions/hello/main.tsx
const { register, react } = window.__opencodeUI;

register({
  kind: "region",
  id: "hello",
  region: "footer",
  render: () => react.createElement("span", null, "hello from a user extension"),
});
```

## Extension kinds (the contract)

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

### Hook events

| Event | `ctx` shape | When |
| --- | --- | --- |
| `session.prompt` | `{ text: string, sessionID: string }` — mutate `ctx.text` to transform; call `next()` to continue | Composer `submit` before `POST /api/session/{id}/prompt` |
| `message.render` | `{ message: MessageInfo, sessionID?: string }` — mutate `ctx.message` (shallow clone) before render | `MessageItem` before `message` renderer |
| `store.dispatch` | `{ action, ... }` | store middleware observer |

## Regions (render points)

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

## Add / remove / disable (app repo)

| Action | How |
| --- | --- |
| Add | Create `ui-extensions/<name>/`, add one import to `ui-extensions/index.ts`. Appears instantly via HMR. |
| Remove | Delete the import line and the folder. |
| Disable | Remove its id from the `enabled` list in `ui-extensions/config.ts` — one line, applies instantly via HMR, no reload. |

The `enabled` list in `ui-extensions/config.ts` is the runtime switch: only
ids listed there are rendered, even if the code is bundled. (A settings-panel
UI could drive the same list later — the mechanism is already in place.)

## Reporting bugs

`/report` in the composer files a prefilled GitHub issue against
AbdelftahZowail/opencode-webui with a diagnostics bundle (build version, user
agent, enabled extension ids, window error ring). `--agent` hands the same
bundle to the session agent instead: when the user asks you to file it and
`gh` is authenticated, create the issue yourself from the bundle — the webui
never holds GitHub credentials. The engine's built-in `/report` skill is a
different thing (different repo, different diagnostics).
