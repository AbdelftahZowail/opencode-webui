# opencode-webui

A web frontend for the **OpenCode v2** engine, inspired by DeepSeek Harness's
web UI (`dsh web`). The engine is the opencode background service — this
project is only a client of its HTTP API, so the TUI and the web UI share
the same sessions.

## Quick start

```sh
bun install
bun run dev        # proxy (4097) + Vite (5173), open http://localhost:5173
```

Production:

```sh
bun run build
bun start          # serves dist/ + API on http://127.0.0.1:4097
```

## What works today

- Session list, create, delete (rename is next)
- Chat with **streaming** output (text, reasoning, tool calls with live JSON input)
- Slash commands and skill activation from the composer (`/`)
- Model & agent switching per session, Stop button
- **Permission approval dialogs** (allow once / always / deny)
- **Interactive form dialogs** (string, number, boolean, multiselect)

## How it works

```
browser ──/api──> Bun proxy (server/index.ts) ──auth──> opencode service
   └── dist/ served by the proxy in production
```

The browser never holds service credentials: the proxy discovers the
background service (`Service.ensure()`), attaches auth headers, and forwards
`/api/*` with streaming preserved. Dev mode adds Vite with HMR — edit any UI
file and it applies instantly; the opencode service is never restarted.

**Everything is hot-reloadable**: UI edits → instant HMR; proxy edits →
auto-restart via `bun --watch`; engine plugins → reloaded by opencode itself.

See `AGENTS.md` for the architecture, editing rules, and roadmap (workspace
picker, file explorer + diffs, shell/PTY panels, settings, inbox…).
