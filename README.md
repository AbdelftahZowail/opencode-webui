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
| `WEBUI_ALLOWED_HOSTS` | loopback + bind host | Extra hostnames/IPs accepted (comma-separated, e.g. `192.168.1.5,myserver.lan`). `*` accepts everything — your call, your risk. |
| `WEBUI_TRUST_PROXY` | unset | Set to `1` when a trusted reverse proxy sits in front, so `X-Forwarded-Host`/`Proto` are honored. Without it those headers are ignored. |
| `WEBUI_PROXY_PORT` | `4097` | Port for the UI and `/api/*`. |
| `WEBUI_EXTENSION_DIR` | the global + project dirs | Adds a higher-precedence source shadowing both (the sandbox uses this to keep WIP isolated; shipped extensions still load underneath). |
| `WEBUI_NO_SETUP` | unset | `1` skips first-run setup for this run (CI, one-offs). |
| `WEBUI_NO_PLUGIN` | unset | `1` installs the global command but not the OpenCode lifecycle plugin. |
| `WEBUI_SETUP` | unset | `1` forces setup even in a repo checkout (testing). |

Sessions are shared with the `opencode` TUI — open a session in the TUI, continue it in the browser.

### Setup (run once) — the `opencode-webui` command + OpenCode plugin

First boot self-installs two things, so you don't pay for `bunx` on every
start and the webui comes up with OpenCode:

1. **A global `opencode-webui` command** (`~/.local/bin/opencode-webui`, or
   `WEBUI_BIN_DIR`) that execs the installed entry directly — fast, no bunx
   resolution. The first-boot banner tells you if that directory isn't on
   `PATH`.
2. **A built-in OpenCode lifecycle plugin** written to
   `~/.config/opencode/plugins/opencode-webui/`, which the engine
   auto-discovers. It starts the webui in the background as soon as OpenCode
   activates its plugins (i.e. when you use OpenCode) — detached,
   fire-and-forget, and it never starts a second copy (a running webui answers
   on its port and wins).

```sh
opencode-webui            # start (starts the opencode service first if needed)
opencode-webui update     # update to the latest version and restart
opencode-webui status     # command, plugin, launch command, running pid
opencode-webui restart    # restart the background webui
opencode-webui stop       # stop it
opencode-webui uninstall  # remove the command + plugin (remembered; no auto-reinstall)
```

A repo checkout (`bun run dev` / `bun run start`) never self-installs, so
development cannot fight your installed command. `WEBUI_NO_SETUP=1` skips
setup for one run, `WEBUI_NO_PLUGIN=1` installs the command but not the plugin.
The plugin only ever starts a webui that is already installed; it installs
only its own folder and removes it cleanly on `uninstall`.

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
- Login sets a signed **HttpOnly `SameSite=Strict`** cookie — `Secure` too when the request arrived over https (`X-Forwarded-Proto`, honored with `WEBUI_TRUST_PROXY=1`).
- Login is rate-limited per IP with constant-time comparison; `Host`/`Origin` headers are validated against loopback + bind host + `WEBUI_ALLOWED_HOSTS` (`*` opts out — explicit, logged at boot).
- Wildcard bind is refused unless a password is set — the refusal names the env var.
- Remote access in one line: `WEBUI_HOST=<this-machine's-LAN-IP> WEBUI_PASSWORD='<you-pick>' bunx opencode-webui`, then open `http://<that-IP>:4097` on the other device. DHCP may reassign the IP — pin a static one on your router if it annoys you.

Behind a reverse proxy (Caddy / nginx samples, incl. websocket + SSE timeouts):
[docs/reverse-proxy.md](docs/reverse-proxy.md).

## Sandbox

A second, private instance for agents (or you) to test extensions and settings
without touching your main webui — no clone, no build, works with the npm
package and the prebuilt binaries:

```sh
bunx opencode-webui sandbox       # bun users
./opencode-webui-linux-x64 sandbox  # binary users
bun run sandbox                   # inside a repo checkout (adds Vite + HMR)
```

It binds `127.0.0.1:4099` — loopback only, **no password** (the bind address is
the guarantee; a non-loopback sandbox is refused at startup) — attaches to your
already-running opencode engine (same sessions, live), and loads extensions
from an isolated scratch dir (`~/.local/state/opencode-webui/sandbox-extensions/`)
instead of the real ones. Iterate there; "ship" = copy the folder into
`~/.config/opencode/webui-extensions/` and the main instance picks it up
within its poll cycle.

## The agent skill

On every boot the webui syncs its skill to `~/.config/opencode/skills/webui/SKILL.md` —
no opt-in. That skill is how your agent learns the webui exists, what its extension
system can do, and how to file reports for it. `--install-skill` runs the same sync
manually.

## Extensions

One extension = one folder, dropped in — no rebuild, no restart:

- `~/.config/opencode/webui-extensions/<name>/` — per-user
- `<project>/.opencode/webui-extensions/<name>/` — per-project

```
my-extension/
  manifest.json    id, version, description, disabled?
  index.tsx        browser stratum (wrap / replace / contribute / hook / service)
  dom.ts           DOM stratum (portals, canvas, post-render tweaks)
  server.ts        proxy stratum (routes, middleware, event tap, pollers)
  engine/          opencode plugin payload (model tools, prompt hints)
```

Presence = installed, `disabled: true` = paused, delete = uninstalled; a
higher-precedence folder with the same id shadows the shipped one, so user
customizations survive core updates with no forks. Hot reload everywhere:
browser edits repaint live via the manifest SSE push, proxy edits reload
with no restart. The full authoring guide — the five kinds, hook catalog,
DOM kit, `server.ts` mounts, precedence, and the timestamp worked example —
is [webui-extensions/README.md](webui-extensions/README.md).

The built-in `/report` command files a prefilled GitHub issue with a diagnostics
bundle (build version, enabled extensions, error ring); `--agent` hands it to the
session agent instead, so it can file it via `gh`.

## Development

```sh
bun install
bun run dev        # proxy (4097) + Vite (5173), HMR
bun run sandbox    # isolated second instance (4099 / 5175, Vite in dev) — see Sandbox above
bun run typecheck
bun run build && bun start   # production: dist/ + API on 4097
```

- Extension authoring guide: [webui-extensions/README.md](webui-extensions/README.md)
- Extension contract check: `bun run scripts/uitest/extensions-check.ts`
- Setup check: `bun run check:setup` (global command + lifecycle plugin + CLI, isolated HOME/XDG)
- Architecture, editing rules, roadmap: [AGENTS.md](AGENTS.md)

## License

MIT (add LICENSE before publishing).
