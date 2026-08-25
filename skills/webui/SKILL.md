---
name: webui
description: Use when the user asks to customize, extend, or fix the opencode-webui frontend (the web UI for OpenCode v2) — layout changes, new panels, styling, chat/message rendering, permission or form dialogs, or wiring new OpenCode API resources into the UI. Loads the project's AGENTS.md guide as the source of truth.
---

# opencode-webui

A web frontend for the OpenCode v2 engine (the engine is the background
`opencode` service; this project is only a client of its HTTP API).

## Before doing anything

1. **Read `/home/zowail/opencode-webui/AGENTS.md`** — it is the authoritative
   guide: architecture (Bun proxy → service), where every file lives, the
   hot-reload contract, editing rules, and the feature roadmap.
2. If the task touches the API contract layer (`src/api/types.ts`,
   `src/api/client.ts`), get the current OpenAPI spec first and diff against
   it — never guess field names:
   `bun run scripts/fetch-openapi.ts` writes live `GET /openapi.json` (via
   `Service.ensure()` like the proxy) to `docs/reference/openapi.json`; then
   `bun run scripts/diff-openapi.ts` shows drift and `git diff docs/reference/openapi.json` is the raw contract diff.
   See `docs/coverage.md` for the full have / don't-have / why map.
3. Run `bun run typecheck` after any change; the project must stay clean.

## Key facts to remember

- **Do not restart the opencode service.** UI work only edits files under
  `src/`, `ui-extensions/` and `server/`; Vite HMR applies UI changes
  instantly, and the proxy auto-restarts on server edits.
- **New UI features go in `ui-extensions/`** (plain React, registered
  against stable slots: `sidebar`, `footer`, `composer.replace`,
  `tool.renderer`) — NOT new hardcoded places in core components. Read
  `ui-extensions/README.md` first; `ui-extensions/index.ts` is the wiring
  file. Adding a slot is a core change — update the registry, the app
  render point, and both docs.
- **The browser never sees service credentials** — everything goes through
  the proxy in `server/index.ts`. Keep it that way.
- **State lives only in `src/store.ts`** (event reducer + actions). UI
  components read with `useStore((s) => ...)` and call actions; one-shot
  catalog fetches (models/agents/commands/skills) are the only direct API
  calls in components.
- **The chat UI is event-driven**: history from the messages endpoint,
  live output from the `/api/event` SSE stream. Adding a new kind of live
  rendering means handling its event type in the store's `handleEvent`.

## Keeping the API current

- **Snapshot:** `docs/reference/openapi.json` is the versioned "last covered" spec (111 paths as of this doc). Live is whatever `Service.ensure()` returns — check drift with `bun run scripts/diff-openapi.ts`.
- **Weekly / after upstream update:** `bun run scripts/fetch-openapi.ts` → review `git diff` → run `bun run scripts/diff-openapi.ts --check` in CI → add missing client methods/types (`src/api/client.ts:368`, `src/api/types.ts:1`) → decide UI or mark as client-only with a reason row in `docs/coverage.md:1` → update `AGENTS.md:31` / `HANDOFF.md` if user-visible → `bun run typecheck`.
- **Dual stack:** new build docs ship an optional Effect variant (`@opencode-ai/client/effect`, `packages/plugin/src/v2/effect`, `@opencode-ai/sdk@dev` Effect API). Webapp stays Promise (`server/index.ts:13` + `src/api/client.ts:113`). Same OpenAPI — no code change required. Refs: `docs/coverage.md#dual-stack`.

## Common tasks

- "Change the look of X" → Tailwind classes in `src/components/`.
- "Add a panel for Y" → an extension: folder in `ui-extensions/`, one line
  in `ui-extensions/index.ts`, `register({ id, slot, render })`. Preview on
  the dev page (5173) or `bun run preview` (5174) before shipping.
- "Wire up a new API resource" → add types + client function first, then a
  component, then a roadmap checkmark in AGENTS.md and a row in `docs/coverage.md`.
