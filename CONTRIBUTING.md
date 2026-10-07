# Contributing

Thanks — issues and PRs are welcome. This is a self-hosted, MIT-licensed project
(see [LICENSE](LICENSE)). The short version is below; the **full rules live in
[AGENTS.md](AGENTS.md)** (architecture + the editing rules + a "where to look"
router), and the docs index is [docs/README.md](docs/README.md).

## Start here

1. [AGENTS.md](AGENTS.md) — architecture, the non-negotiable editing rules, the router.
2. [docs/principles.md](docs/principles.md) — what we build and what we don't.
3. [docs/README.md](docs/README.md) — the docs tree, by kind.

## Dev setup

```bash
bun install
bun run dev        # proxy + Vite with HMR → http://localhost:5173
bun run sandbox    # isolated second instance (loopback, passwordless) for extension work
bun run typecheck
bun run build
```

Need a running engine: the webui is a client of the OpenCode v2 engine; `bun run
dev` attaches to the one already running, and `server/engineDiscovery.ts`
resolves it (with a registration fallback for drifted engines).

## Ground rules (the ones people trip on)

- **The store is the only place state lives.** Components read via
  `useStore((s) => ...)`; recurring work goes through `src/lib/scheduler.ts` — no
  component-owned `setInterval`.
- **Component files export components only.** A runtime non-component export
  disables React Fast Refresh for the whole file; helpers go in `src/lib/`.
- **Styling:** Tailwind v4 utilities + `var(--…)` tokens from `src/styles.css` —
  never hardcode hex.
- **Every new component self-registers and renders through its `<Target>`** —
  registering without a `<Target>` call site means wraps do nothing.
- **No new dependencies without justification.** Intended surface: React,
  react-markdown, vendored shadcn/ui + Radix, lucide-react, Tailwind. Approved
  exceptions: `@shadcn/react`, `@xterm/xterm` + addon-fit.
- **Never change the API contract layer without the OpenAPI snapshot**
  (`src/api/client.ts` / `types.ts`) — see
  [docs/runbooks/engine-update.md](docs/runbooks/engine-update.md).
- **Touching the extension system? Ids are contract.** Renaming/moving a target,
  slot, collection, service, event string, `data-oc-*` anchor, or manifest field
  = version bump + migration note + docs + skill, same commit — see
  [docs/runbooks/add-extension.md](docs/runbooks/add-extension.md).

## Before you open a PR

- `bun run typecheck` and `bun run build` are green.
- **Extension-system changes:** the four batteries must pass (76 checks) — and
  run them **sequentially and alone** (a concurrent agent evicts the proxy tap
  ring and flakes a test):
  ```bash
  bun run scripts/uitest/ext-battery-browser.ts   # 34
  bun run scripts/uitest/ext-battery-dom.ts       # 10
  bun run scripts/uitest/ext-battery-proxy.ts     # 17
  bun run scripts/uitest/ext-battery-acceptance.ts # 15
  ```
- Keep **extension-system changes and unrelated changes in separate commits**.
- Never hand-edit `docs/reference/openapi.json` (generated).

## Where to look by task

See the router at the end of [AGENTS.md](AGENTS.md#where-to-look-router--read-before-you-act).
In short: contract/API → `docs/runbooks/engine-update.md`; a component →
`docs/runbooks/add-ui-surface.md`; the extension system →
`docs/runbooks/add-extension.md`; parity work → `docs/plans/parity.md`.

## Releasing

Maintainer-only. The runbook is [`.opencode/release-helper.md`](.opencode/release-helper.md)
(the super-vibe ship skill reads that exact path).
