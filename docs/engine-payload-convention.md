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

## Worked example — brother-agent in webui terms, one folder, three strata

- `engine/` registers the `brother_agent*` tools (model-callable).
- `server.ts` taps events (`onEvent`) and queues finish notices into parent
  sessions headless — works with all browser tabs closed.
- `index.tsx` renders the sidebar badge (browser stratum).

## What the webui will never build here

A plugin loader, engine hot-reload, or an engine↔webui RPC bridge. Those
belong to the engine; "the engine boundary" (spec §2.4) is out of scope.
