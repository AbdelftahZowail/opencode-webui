---
name: webui
description: opencode-webui — the browser frontend for the OpenCode engine. Load when the user mentions the webui/web frontend, asks about webui extensions, wants to BUILD, ADD, CHANGE, DEBUG, or TEST a webui extension, or wants to report a webui bug (/report does it).
---

# OpenCode webui (opencode-webui)

The browser frontend for the OpenCode engine — same engine, same sessions as
the `opencode` TUI, with a Bun proxy in front so the browser never holds
service credentials. One port for UI + `/api/*`: http://localhost:4097
(`WEBUI_PROXY_PORT`).

- **Repo**: https://github.com/AbdelftahZowail/opencode-webui
- **This skill's version**: 2.2.0 (matches the `v2.2.0` git tag —
  the file links below are pinned to it, so they always describe the code
  this skill was generated with)
- **A running instance exposes its version** at `GET /api/webui/config` →
  `{ version, reportRepo }`, and on the page as `window.__opencodeUI.version`.

## Source catalog (fetch, don't read local checkouts)

Everything needed to author extensions is below; when a table isn't enough,
fetch the exact file at the pinned tag instead of reading a local clone:

| File | Purpose |
| --- | --- |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v2.2.0/webui-extensions/README.md | Full authoring guide — the source of truth for strata/kinds/hooks/anchors |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v2.2.0/src/extensions/registry.tsx | The extension registry — exact register() shapes per kind |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v2.2.0/src/extensions/hooks.ts | Shared fireHooks runner — how open hook events fire |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v2.2.0/src/lib/domKit.ts | DOM-stratum kit (foreign/watch/styles) + the data-oc-* anchor table |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v2.2.0/server/ext/types.ts | Proxy-stratum types — server.ts routes/middleware/onEvent/pollers shapes |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v2.2.0/docs/extension-system-spec.md | The v2 decision record — strata, precedence, deletions, acceptance checks |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v2.2.0/src/store.ts | The store — actions useStore exposes to extensions |

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBUI_PASSWORD` | generated on first boot, printed once | Shared login passphrase. |
| `WEBUI_HOST` | `127.0.0.1` | Bind address — a wildcard is refused without a password. |
| `WEBUI_PROXY_PORT` | `4097` | Port for the UI and `/api/*`. |
| `WEBUI_EXTENSION_DIR` | the global + project dirs | Replace both with ONE directory (the sandbox does this to keep WIP isolated). |
| `WEBUI_ENGINE_URL` | `service.json` discovery | Aim the proxy at a chosen engine — skips `Service.ensure()`, so a stale pid can never spawn a rogue serve. Explicit env wins. |
| `WEBUI_ENGINE_PASSWORD` | `service.json` password | Engine password for the override above (no file fallback when the URL is overridden — a chosen engine has its own credential). |
| `WEBUI_SANDBOX_NOVITE` | unset | `1` — sandbox boots the proxy only, no Vite (`--no-vite` flag does the same). |
| `WEBUI_CRASH_LOG` | `$XDG_STATE_HOME/opencode-webui/proxy-crash.log` | File fatal proxy errors (`uncaughtException`/`unhandledRejection`) are appended to; the last entry prints on next boot. |
| `WEBUI_DEBUG` | unset | `1` — server/proxy debug logs to stdout. |
| `WEBUI_DEBUG_LOG` | `/tmp/webui-debug.log` | File the frontend log sink (`POST /api/debug`) appends to. |

### Parallel sandboxes (one per extension under test)

Yes — run as many sandboxes at once as you need. `bun run sandbox` stacks
with no flags: the first instance takes the fixed defaults (`:4099`/`:5175`
+ shared scratch dir); every further instance detects the busy ports and
auto-isolates onto free ports + a fresh mkdtemp extension dir, printing what
it picked. Explicit env (`WEBUI_PROXY_PORT` / `WEBUI_VITE_PORT` /
`WEBUI_EXTENSION_DIR`) always wins per knob. The engine stays shared
(same sessions everywhere, by design) — only ports + extension dirs are
isolated. Rules: one sandbox per extension, never two writers to one ext
dir, never reuse a port.

## What you can do for the user

- **File a webui bug** — the composer ships a built-in `/report` command that
  bundles diagnostics (build version, user agent, enabled extension ids, error
  ring) into a prefilled GitHub issue for AbdelftahZowail/opencode-webui (see
  Reporting bugs below).
- **Explain the extension system** from the tables below — they are extracted
  verbatim from the authoring guide (`webui-extensions/README.md`), which is the
  source of truth.
- **Author an extension folder** for the user — one folder, no build step, no
  restart. Pick the stratum that matches the job (React tree → browser,
  portals/canvas/post-render → dom.ts, headless/always-on → server.ts,
  model tools → engine/).

## The model in one minute

One extension = **one folder**: `manifest.json` (id, version, description,
`disabled`?) + `index.tsx` (browser stratum) + `dom.ts` (DOM stratum) +
`server.ts` (proxy stratum) + `engine/` (opencode plugin payload).
Presence = installed; `disabled: true` = paused; delete the folder =
uninstalled. Precedence, highest wins: `~/.config/opencode/webui-extensions/`
(user) → `<project>/.opencode/webui-extensions/` (project) → shipped
`webui-extensions/` (ours). Dropping a folder in the extension dir is an
act of trust — extension code is not sandboxed.

### Add / pause / remove

| Action | How |
| --- | --- |
| Add | Create `webui-extensions/<name>/` with `manifest.json` + `index.tsx` calling `register({ kind, ... })`. Loads without rebuild/refresh/restart (manifest SSE push, same-id swap). |
| Pause | Set `"disabled": true` in its `manifest.json` — gone on the next manifest push. |
| Remove | Delete/move the folder — the id vanishes from the manifest. |
| Shadow | Same id at higher precedence wins; core updates still flow everywhere else. |

Authoring rules (kinds, hook events) are identical in every source — the
tables below apply to each. Full hot-reload guarantees and the timestamp
worked example are in the authoring guide.

### Minimal extension (wrap — the default path for edits)

```tsx
// ~/.config/opencode/webui-extensions/my-time/{manifest.json,index.tsx}
import { register } from "opencode-webui/extensions"; // shipped dirs import from src; external dirs use the extension API surface

register({
  kind: "wrap",
  id: "my-time",
  target: "Timestamp",
  render: (props, next) => <span className="tabular-nums">{next()}</span>,
});
```

## Five kinds, one job each (the contract)

| Kind | Job | Staleness |
| --- | --- | --- |
| `wrap` | Flow-through tweak of any registered target: `render(props, next)` — transform props/output, delegate to live core by default | **Stale-proof by construction.** Core updates always render *through* it. The default path for edits. |
| `replace` | Take ownership of one registered target: `render(props, core)` wins outright at its priority; return `null` to fall through to the next candidate / core | **Frozen snapshot.** You opt out of core updates for that target — the marked escape hatch. Still receives `core` so you *can* compose. |
| `contribute` | Add an item to a named collection (`collection` + `item`, `order` sorts, lower first) | Data, not code — core owns the list, you own your row. |
| `hook` | Interception at instrumented boundaries: `{ event, handler(ctx, next) }` — `event` is an open string | New seams are new event names, never a registry change. |
| `service` | Provide named logic: `{ service, value, precedence }` — consume via `getService(id)`; highest precedence wins | **Value overrides.** Core consults services for pluggable values (e.g. the timestamp formatter), so tiny logic tweaks never touch markup. |

Contribute collections (registry-owned lists — data, not new kinds):
`palette`, `slash` (UI-only; engine commands win name clashes),
`pages` (routed at `/ext/{id}`), `settings`,
`contextMenu.message` / `contextMenu.session` / `contextMenu.file`.

### Hook catalog

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

Browser hooks affect only their own browser — transforms affecting *all*
clients go in proxy `server.ts` middleware. Proxy mounts (`server/ext/`):
`routes` at `/api/webui/ext/<id>/…`, `middleware` over `/api/*`,
`onEvent` tap (works with all tabs closed), `pollers`, per-extension KV.

## DOM anchors (the free layer)

`dom.ts` + the kit (`foreign`/`watch`/`styles`, mount/dispose) covers
what the React tree cannot: mid-component DOM, portals, canvas/xterm,
iframes. Stable anchors below are contract — renaming one is a version bump
+ migration note. DOM is the marked last resort ("outside the contract; you
own the fragility").

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

## Sandbox (iterate without touching the user's webui)

A second, private instance for authoring/testing extensions — no repo
needed. Start it the same way the package runs, plus `sandbox`:
`bunx opencode-webui sandbox` (or `./opencode-webui-<target> sandbox`).
It binds `127.0.0.1:4099` — loopback-only, NO password (a non-loopback
sandbox is refused) — and loads extensions from an ISOLATED scratch dir
(`~/.local/state/opencode-webui/sandbox-extensions/<name>/`), so WIP
is invisible to the user's main instance. Same engine, same sessions as the
main instance. Workflow: write the extension folder in the scratch dir →
watch it load in the sandbox via the manifest push (sub-second) → fix until
right → then copy the folder into `~/.config/opencode/webui-extensions/<name>/`
to ship it to the user (or `<project>/.opencode/webui-extensions/<name>/`
for one project). Do not write user extensions directly into the real dirs
while iterating — that exposes WIP to the user's browser immediately.

## Reporting bugs

`/report` in the composer files a prefilled GitHub issue against
AbdelftahZowail/opencode-webui with a diagnostics bundle (build version, user
agent, enabled extension ids, window error ring). `--agent` hands the same
bundle to the session agent instead: when the user asks you to file it and
`gh` is authenticated, create the issue yourself from the bundle — the webui
never holds GitHub credentials. The engine's built-in `/report` skill is a
different thing (different repo, different diagnostics).
