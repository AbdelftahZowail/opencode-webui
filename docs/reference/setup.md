# Setup reference — first-run install (command + managed plugins)

Moved out of `AGENTS.md`. `server/setup.ts` makes the webui self-install once, so
users don't pay for `bunx` on every start and the webui comes up with OpenCode.
`server/index.ts` calls `ensureSetup()` after the port binds.

- **Global command**: a `~/.local/bin/opencode-webui` wrapper (overridable via
  `WEBUI_BIN_DIR`, falling back to `~/.bun/bin`) that execs the installed entry
  with bun directly — no bunx resolution, no network. Re-rendered when the
  resolved argv changes, so an upgrade self-heals. A bunx entry lives in a temp
  dir the OS wipes, so it is mirrored first into `<state>/entry/<version>/`
  (hardlinks — no disk, no network) and the wrapper + `launch.json` point at the
  mirror; that is what keeps `bunx opencode-webui` and the lifecycle plugin
  working across reboots.
- **Managed engine plugins (three)**: first-run setup writes ALL three built-in
  engine plugins, each in its own marker-gated directory under
  `<config>/opencode/plugins/`, which the engine auto-discovers globally:
  - `opencode-webui/` — the lifecycle plugin (`server/lifecyclePlugin.ts`,
    embedded CommonJS `{ id, setup }`). Activation is LAZY on the engine's side
    (verified with `check:setup:engine`): the first `/api/plugin` read — i.e.
    first use — loads the location's plugins, and `setup()` then starts the
    proxy detached (fire-and-forget) if the port isn't already answering.
  - `opencode-webui-shelf/` — the shelf tools plugin
    (`server/shelfEnginePlugin.ts`): the `shelf_share` / `shelf_list` /
    `shelf_remove` tools + the shelf system hint.
  - `opencode-webui-preview/` — the inline-preview hint plugin
    (`server/previewEnginePlugin.ts`): a hint-only payload (no tools) that
    teaches the model the `~~~` tilde-fence convention the webui renders live
    (`~~~html` / `~~~svg` / `~~~pdf` / `~~~image`; `backtick` fences stay code) —
    the renderer is core (which also accepts the `live-*` aliases), the hint is
    what makes it used.
  This is the documented exception to "the webui never installs engine plugins"
  (see `engine-payload-convention.md` §2).
- **Handoff**: each boot writes `launch.json` in the state dir (argv + port +
  version) — the stable thing the plugin and `restart` read; plus `webui.pid`
  so `stop`/`restart`/`update` can find the server (verified pid before signal).
- **One gate, user-owned**: `uninstall` removes the wrapper + ALL THREE managed
  plugin dirs + handoff and writes a declined marker so the next boot won't resurrect
  it; `opencode-webui setup` re-enables. `WEBUI_NO_SETUP=1` skips a run,
  `WEBUI_NO_PLUGIN=1` installs the command but none of the three plugins,
  `WEBUI_SETUP=1`
  forces a dev checkout. Sandbox never installs.
- **Foreign files are never clobbered**: the wrapper and each plugin dir are only
  overwritten when they carry our marker.
- **Update**: `opencode-webui update` runs `bun x opencode-webui@latest
  internal:setup` (which installs the NEW version's artifacts), then stops and
  respawns the server. Compiled binaries print the releases URL instead.
- The engine is ensured **eagerly** at boot with a 6s bound (a cold spawn can't
  hold the banner); a manual run on an occupied port probes `/login` for the
  webui fingerprint and exits 0 instead of dying on EADDRINUSE.
