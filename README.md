# opencode-webui

Web frontend for the OpenCode v2 engine — same engine, same sessions as the `opencode` TUI.
The browser never holds service credentials: a Bun proxy fronts the engine and owns the auth.

## Install

Requires [Bun](https://bun.sh):

```sh
bunx opencode-webui
```

The opencode engine is started automatically if it isn't already running.
First boot prints the URL and a generated password — **shown once**:

```text
  opencode-webui
  → http://localhost:4097

  password    patch-orbit-vault-glare
              generated for this install — shown once
              set WEBUI_PASSWORD to choose your own
  sessions    the same ones as your opencode TUI — same engine, same history
  extensions  ~/.config/opencode/webui-extensions/<name>/main.tsx   per-user
              <project>/.opencode/webui-extensions/<name>/main.tsx  per-project
  skill       agent skill synced to ~/.config/opencode/skills/webui/ — your agent knows this UI exists
```

Options:

| Variable | Default | |
| --- | --- | --- |
| `WEBUI_PASSWORD` | generated on first boot | Log in with this passphrase. Set it to pin your own instead of the generated one. |
| `WEBUI_HOST` | `127.0.0.1` | Bind address. A wildcard (`0.0.0.0` / `::`) is refused without a password. |
| `WEBUI_PROXY_PORT` | `4097` | Port for the UI and `/api/*`. |

Sessions are shared with the `opencode` TUI — open a session in the TUI, continue it in the browser.

## Install (no Bun)

Binaries are attached by CI on each version tag — grab one for your platform from
[GitHub Releases](https://github.com/AbdelftahZowail/opencode-webui/releases),
`chmod +x`, run. Same env vars, same first boot.

```sh
chmod +x opencode-webui-linux-x64
./opencode-webui-linux-x64
```

## Security

- One shared passphrase for the whole UI. Generated on first boot if `WEBUI_PASSWORD` is unset, printed once.
- Login sets a signed **HttpOnly `SameSite=Strict`** cookie — `Secure` too when the request arrived over https (`X-Forwarded-Proto`).
- Login is rate-limited per IP with constant-time comparison; `Host`/`Origin` headers are validated.
- Wildcard bind is refused unless a password is set — the refusal names the env var.

Behind a reverse proxy (Caddy / nginx samples, incl. websocket + SSE timeouts):
[docs/reverse-proxy.md](docs/reverse-proxy.md).

## The agent skill

On every boot the webui syncs its skill to `~/.config/opencode/skills/webui/SKILL.md` —
no opt-in. That skill is how your agent learns the webui exists, what its extension
system can do, and how to file reports for it. `--install-skill` runs the same sync
manually.

## Extensions

Plain React, dropped in a folder, loaded at runtime — no rebuild, no restart:

- `~/.config/opencode/webui-extensions/<name>/main.tsx` — per-user
- `<project>/.opencode/webui-extensions/<name>/main.tsx` — per-project

Toggle any extension in Settings › Extensions. The full authoring guide — the kind
contract, hooks, region markers, the `window.__opencodeUI` bridge — is
[ui-extensions/README.md](ui-extensions/README.md).

The built-in `/report` command files a prefilled GitHub issue with a diagnostics
bundle (build version, enabled extensions, error ring); `--agent` hands it to the
session agent instead, so it can file it via `gh`.

## Development

```sh
bun install
bun run dev        # proxy (4097) + Vite (5173), HMR
bun run preview    # isolated second instance (5174 / 4098) for WIP edits
bun run typecheck
bun run build && bun start   # production: dist/ + API on 4097
```

- Extension authoring guide: [ui-extensions/README.md](ui-extensions/README.md)
- Extension contract check: `bun run scripts/uitest/extensions-check.ts`
- Architecture, editing rules, roadmap: [AGENTS.md](AGENTS.md)

## License

MIT (add LICENSE before publishing).
