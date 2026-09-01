# Ship Checklist — user-ready app

> What remains to make `opencode-webui` shippable to power users (build-your-own
> extensions, public domain, one command). Extension coverage is done —
> `src/extensions/registry.tsx` has 11 kinds, `bun run typecheck` clean.
> Order = build order. 1–3 are independent and can land in one pass; 4–5 are the real work.

## Must-have (blocks v1.0)

- [ ] **Auth for public domains** — `server/index.ts`
  - Env `WEBUI_PASSWORD` or auto-generated on first boot, printed once.
  - `GET /login` + `POST /api/auth/login` -> signed HttpOnly cookie (HMAC, `SameSite=Strict`, `Secure` when `X-Forwarded-Proto: https`), constant-time compare, 5/min rate limit per IP.
  - Middleware gates every `/api/*` + page + SSE/WebSocket; `GET /api/auth/logout` clears cookie.
  - Safety rail: refuse `0.0.0.0`/`::` bind unless password set — and the refusal message names the env var to set.
  - Effort: ~80 lines. Design agreed (single shared passphrase, no multi-user in v1).
  - Make sure its absloutly safe (user's note)
- [ ] **First-boot banner** — `server/index.ts`
  - Print URL + generated password (once) + `WEBUI_PASSWORD` hint + extension-dir hint + "same sessions as your TUI".
  - The banner IS the onboarding for one-command installs — write the wording before publishing, not after.

- [ ] **One-command package with prebuilt `dist`** — `package.json`
  - `dist/` built locally, shipped in tarball via `files: ["dist","server","skills"]`, not built by users.
  - Add: `"private": false`, `"bin": {"opencode-webui":"./server/index.ts"}` + shebang `#!/usr/bin/env bun` on `server/index.ts`, `"prepublishOnly":"bun run typecheck && bun run build"`.
  - `Service.ensure()` already auto-starts the engine — keep "starts the engine if not running" prominent in the README quickstart.
  - Effort: ~10 lines + `npm publish --access public`. (Name `opencode-webui` is free on npm — verified 2026-08-31.)
  - ask the user for what you need like a proper account/creds before starting this point (user's note)
- [ ] **Phase C: user extension dirs (prod builder path)** — `server/index.ts` + `src/lib/runtimeExtensions.ts`
  - Today only `plugin/*.ui.tsx` and built-in `ui-extensions/` are runtime. Power users who build their own still need a repo checkout — the pitch isn't real until this lands.
  - Scan `~/.config/opencode/webui-extensions/<name>/main.tsx` and `<project>/.opencode/webui-extensions/<name>/main.tsx` via the same `Bun.build` pipeline (self-contained React, `window.__opencodeUI` bridge). Gated same as plugin UIs (default ON, Settings › Extensions toggle).
  - Effort: ~40 lines (reuse the plugin UI-entry discovery + bundling verbatim).

- [ ] **Extension contract check** — `scripts/uitest/extensions-check.ts`
  - The registry is the declared stable contract and the only layer with zero probe coverage — nothing fails a build when a kind's plumbing breaks.
  - Flow: create a throwaway `ui-extensions/<tmp>/index.tsx` registering one of every kind → wait for HMR discovery → assert registration/render (region, slash, command, page route) → delete the folder → assert `pruneExtensions` cleaned up.
  - Exercises the real add path, hot-swap, and removal in one run — no standing fixture extension required.
  - Effort: ~1–2 hrs. `bun run preview` (5174/4098) is the isolated instance to run it against.
- [ ] **Prebuilt binaries** — `bun build --compile server/index.ts` with embedded `dist`, attached to GitHub Releases (non-Bun users).
- [ ] **Reverse-proxy docs** — Caddy/Nginx samples (`X-Forwarded-Proto`), `WEBUI_HOST`/`WEBUI_PORT` table.
- [ ] **`--install-skill`** — copies `skills/webui/` to `~/.config/opencode/skills/` (opt-in). (make it works by default instead of opt-in, all users needs to have it, also this skill's info is coming from: ui-extensions/README.md)
- [ ] **`/report`** — `ui-extensions/report/`: client diag bundle (build version, UA, enabled ext ids, window.onerror ring) → prefilled GitHub issue URL; `--agent` mode inserts a gh-CLI prompt for the session agent (webui never holds GitHub creds). Plus `.github/ISSUE_TEMPLATE/bug.yml` + a `webui-report` skill shipped via `--install-skill` — that skill's description is what agents read. Engine's built-in `/report` skill stays untouched: different repo, different diagnostics; the composer menu shows both, descriptions disambiguate (no name dedupe — `Composer.tsx` merges all four slash groups). (make this a built in feature that ships with the web ui by default, include info in the injected info about the webui {more about that at the end})

---

we need a way to inject context about the web ui where it will make the agent understand what's going on if the user mention it, it says about the extensions skills and the web ui report command and any other needed context. see the method it will be done with, whether its tool, just injection or how-ever opencode allows for it, discuss with user fitst

** notes inside () are the user's its top proiority

## Ship-day sequence

```
bun run typecheck && bun run regions && bun run build
bun run scripts/uitest/extensions-check.ts   # once it exists
bunx opencode-webui                          # smoke: login if password set, footer "connected" chip, palette + slash menu
npm version <x.y.z> && npm publish --access public
git tag vX.Y.Z
```

## v1.1 (power-user polish — no order between them)


## Ongoing (habit, not task)

- [ ] `bun run check:swap` after every engine bump — recorder → cursor-replay swap is the one open streaming item.

## Already done (not in this list)

- Extension kinds: 11 (`region`/`command(+keybind)`/`slash`/`message`/`message.decoration`/`message.part`/`contextMenu`/`hook`/`page`/`settings`/`tool.renderer`) + `notify` bridge — `src/extensions/registry.tsx`, `src/components/MessageItem.tsx`, `src/components/Sidebar.tsx`, `src/lib/notify.ts`, `src/lib/extensionHooks.ts`, `src/components/CommandKeybinds.tsx`.
- Region markers (17 via `bun run regions`), `Slots`/`SlotOutlet` with per-item `SlotErrorBoundary`, ancestry gating (`isIdEnabled`), prune/hot add-remove.
- Runtime plugin UI pipeline (`server/index.ts`, `src/lib/runtimeExtensions.ts`, `src/main.tsx` bridge) + per-id kill switch (`src/lib/extGate.ts`, Settings › Extensions).
- HMR coalescing (`vite.config.ts`), watcher ignores for `*.md`.

## Claim corrections (2026-08-31, so they don't rot back)

- Kind count is 11, not 9 (`contextMenu`, `message` were missing).
- Skill path is `skills/webui/SKILL.md` — `.opencode/skills/webui-dev/` never existed in this tree.
- `dev-sandbox` was REMOVED from `ui-extensions/` (only `runtime-status/` ships); old "dev-sandbox showcase done" and "`/ext/dev-sandbox` renders" verification claims were false as written — replaced by the contract check above.
