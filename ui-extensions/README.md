# UI Extensions

Frontend additions live in `ui-extensions/<name>/` and are **plain React
code, compiled into the app** — no plugin framework, no manifests, no dynamic
loading. This is a deliberate choice: extensions keep full type safety, hot
reload, and complete access to the app (store, API client, components).

## The slot contract (stable API)

The app exposes a small set of extension points. **This list is the contract** —
treat it as versioned; the app will only break an extension when a slot is
deliberately changed.

| Slot | What it renders | Example use |
| --- | --- | --- |
| `sidebar` | bottom of the sidebar (below the footer bar) | quick actions, workspace info |
| `footer` | bottom of the app window | status bar, live counters |
| `composer.replace` | replaces the default input composer entirely | custom prompt UIs, agent-steering panels |
| `tool.renderer` | custom card for a specific tool name | pretty renderers for `read`/`bash`/custom MCP tools |

Slots live in `src/extensions/registry.tsx`; adding a new slot there is a
core change (documented in AGENTS.md).

## Anatomy of an extension

```
ui-extensions/
  index.ts          ← the wiring file: imports every extension (edit this)
  hello/
    index.tsx       ← registers against one or more slots
  my-feature/
    index.tsx
    components.tsx  ← anything else; it's just your code
```

`ui-extensions/index.ts` is the only thing the app imports; each extension
folder self-registers:

```tsx
// ui-extensions/hello/index.tsx
import { register } from "../../src/extensions/registry";

register({
  id: "hello",
  slot: "footer",
  render: () => <span>Hello!</span>,
});
```

A tool renderer receives the full tool part:

```tsx
register({
  id: "my-bash-card",
  slot: "tool.renderer",
  toolName: "bash",
  render: (part) => <pre>{part.state.content}</pre>,
});
```

## What extensions can use

Everything the app can — it's the same build:

- `useStore` / store actions from `src/store.ts` (session state, sending prompts, permissions)
- `api` from `src/api/client.ts` (any endpoint)
- UI primitives from `src/components/ui/` (shadcn: `Button`, `Dialog`,
  `DropdownMenu`, `Command`, `Tooltip`, …) — always build on these so
  extensions look native
- The OC-2 design tokens in `src/styles.css` — consume as
  `var(--background-base)`, `var(--text-weak)`, `var(--border-base)`, etc.
  **Never hardcode colors**; tokens keep extensions theme-compatible
- Any component, hook, or CSS class

## Add / remove / disable

| Action | How |
| --- | --- |
| Add | Create `ui-extensions/<name>/`, add one import to `ui-extensions/index.ts`. Appears instantly via HMR. |
| Remove | Delete the import line and the folder. |
| Disable | Remove its id from the `enabled` list in `ui-extensions/config.ts` — one line, applies instantly via HMR, no reload. |

The `enabled` list in `ui-extensions/config.ts` is the runtime switch: only
ids listed there are rendered, even if the code is bundled. (A settings-panel
UI could drive the same list later — the mechanism is already in place.)

## Sharing with others

An extension is a React component, so npm is the sharing format:

```bash
bun add @someone/opencode-webui-status-bar
```

```tsx
// ui-extensions/index.ts
import { register } from "../src/extensions/registry";
import { StatusBar } from "@someone/opencode-webui-status-bar";
register({ id: "status-bar", slot: "footer", render: () => <StatusBar /> });
```

That's it — no plugin API to learn, nothing to build. Publishing a shared
extension is just publishing a component library.

## Preview before production

The dev server (localhost:5173) is the preview: every edit hot-reloads there,
and production (the built app on 4097) only changes when you run
`bun run build && bun start`. For a second, isolated preview page of WIP
changes, run `bun run preview` (localhost:5174, proxy :4098).
