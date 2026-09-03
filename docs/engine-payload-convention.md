# Engine payload convention (spec §9)

An extension folder MAY carry `engine/` — a valid opencode plugin directory
(tools the model calls, `experimental.chat.system.transform` prompt hints,
commands). This is a **convention, not machinery**: the webui neither loads
nor hot-reloads it. Engine rules apply, full stop.

```
my-extension/
  manifest.json    id, name, version, description, disabled (optional bool)
  index.tsx        browser stratum: register() against the registry
  dom.ts           DOM stratum: post-render DOM changes (the free layer)
  server.ts        proxy stratum: routes / middleware / event tap / pollers
  engine/          opencode plugin payload (tools, system-prompt hints)
```

## Rules

1. **Valid plugin, same as any other.** `engine/` must load under the
   engine's own plugin rules (boot-time load). If it doesn't load with the
   engine alone, it won't load here either — debug it as a plugin first.
2. **Registration is the user's.** The user points the engine at it (e.g.
   adds the path to their opencode plugin config). The webui never
   installs, enables, or configures engine plugins on the user's behalf.
3. **No webui loading, no webui hot reload.** The webui serves/carries the
   folder's other strata only. Editing `engine/` follows engine semantics:
   restart on edit, unless the plugin implements its own hot pattern (the
   spec §6 suggestion: a stable shell plugin that stat-polls its own
   definitions file and swaps registrations).
4. **No HTTP self-RPC needed.** The engine's `PluginInput` already provides
   a client and a Bun shell, so plugins coordinate through those — not by
   calling back into `/api/webui/ext/*`.
5. **Strata communicate through durable seams, not imports.** Browser and
   proxy strata must not import from `engine/` (different runtimes,
   different reload rules). If they need shared constants, duplicate the
   literal or read it from a file both sides parse — boring and explicit.

## Worked example — one folder, three strata

A typical multi-strata extension (e.g. an agent-spawning helper):

- `engine/` registers the model-callable tools.
- `server.ts` taps events (`onEvent`) and queues finish notices into parent
  sessions headless — works with all browser tabs closed.
- `index.tsx` renders the sidebar badge (browser stratum).

## What the webui will never build here

A plugin loader, engine hot-reload, or an engine↔webui RPC bridge. Those
belong to the engine; "the engine boundary" (spec §2.4) is out of scope.

<!-- FIXTURE-SECTION-START — owned by the TEST-TOOLING agent (fixture files
     + battery step only). The probe-engine recipe prose above/below this
     block is owned by the docs agent; do not merge the two. -->
## Verified minimal engine fixture (IN-5 proof)

`scripts/uitest/engine-fixture/` is the smallest payload that exercises the
full seam above — one `tools.*` tool returning `{output}`, one
`{type:"text"}` system hint, v2 `{ id, setup }` shape:

- `package.json` — conventional metadata (name/version/private).
- `index.js` — `module.exports = { id: "webui-engine-fixture", setup }`;
  `setup` registers `webui_fixture_ping` via `api.tool.transform` (echoes
  its input as `{ output: "pong: …" }`, no side effects) and pushes the
  hint via `api.session.hook("context", …)` as `{ type: "text", text }`.

Prove it with `bun scripts/uitest/engine-probe.ts` (E1–E4: isolated
`opencode2 serve --service` on a free port with own XDG dirs + cwd;
`/api/plugin` lists the id with state `active`; the tool executes to
`{output}`; the hint is `{type:text}`). E3/E4 run in-process through a
stub api — the engine exposes no headless tool-execute route, and model
execution needs provider credentials the isolated probe deliberately
lacks. New engine work starts by copying this fixture and keeping the
battery green.
<!-- FIXTURE-SECTION-END -->

## Agent-testing runbook (E2E tool calls)

Drive engine tools through a real prompt turn (`POST /session/{id}/prompt`,
letting the model invoke the tool on the execution path), never a bare
direct tool call: a first direct `watch`-style call can flake as
`Unknown tool` while the identical call via a prompt turn succeeds (tool
registration resolves on the execution path). A bare-call failure is
therefore not a finding until the prompt-turn path fails too — always
retry via execute before filing it against the plugin.
