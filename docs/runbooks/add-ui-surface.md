# Runbook — when you add a core UI surface

**Trigger:** adding or changing a core component, target, slot, store slice, or
`data-oc-*` anchor. See `AGENTS.md` "How to change the webui without breaking
extensibility" — that list is binding; this is the checklist form.

## Before you write code

1. **Decide core vs extension.** Native to opencode → **core**. Additive /
  non-native → an extension (never absorb one into core "because it's easier").
2. **Check the parity plan.** If it maps to a TUI affordance, it has a stream in
   `plans/parity.md` §5 with acceptance criteria — implement *that*, match the
   TUI's behaviour, and record any not-ported item with a reason.
3. **Read the contention map** (`plans/parity.md` §6.2) if working in parallel —
   `store.ts` is the serialization point.

## Hard rules

- **Self-register.** Every new component registers into the registry via the
  auto-registration helper, and is **rendered through `<Target id>`**. Both
  halves matter: `autoRegister` without a `<Target>` call site means wraps and
  replaces silently do nothing (this exact bug shipped once — see R0.2 in
  `plans/parity.md`).
- **Leaf granularity + rich props.** Split out leaves for anything plausibly
  tweakable. Tweakable values arrive as **props or consulted services**, never
  baked in — a format-able/route-able/calculable value is a prop.
- **Store is the only place state lives.** Components read via
  `useStore((s) => …)` and call actions. No component-owned `setInterval` —
  recurring work goes through `src/lib/scheduler.ts` (tiers: live/idle/hidden).
- **Components-only exports.** A runtime non-component export in a component file
  disables React Fast Refresh for the whole file. Helpers go in `src/lib/`.
- **Styling:** Tailwind v4 utilities + `var(--…)` tokens from `src/styles.css`.
  **Never hardcode hex.** New components should not add new CSS.
- **Stable anchors.** Meaningful markup boundaries carry `data-oc-*` attributes;
  a restyle must not remove them without a contract bump.
- **No new dependencies** without justification (approved exceptions:
  `@shadcn/react`, `@xterm/xterm` + addon-fit).

## Steps

1. Build the component (new file) against its props; put logic in `src/lib/`.
2. Register it and add its `<Target>` call site; add `data-oc-*` anchors at the
   meaningful boundaries.
3. If it needs placement elsewhere, contribute to a **slot** (`composer.above`,
   `conversation.header.actions`, …) rather than adding a target per location.
4. Wire entry points; keep side effects in the store, not the unit.
5. Gates: `bun run typecheck`, `bun run build`. If you touched the extension
   contract (new target/slot/event), follow `runbooks/add-extension.md` too.

## Definition of done

- typecheck + build green;
- the component is addressable (register + `<Target>` + anchors) and a wrap on it
  actually renders;
- no hex, no new CSS, no new dep, no component-owned timer;
- if it is a parity surface, `reference/coverage.md` reflects it and any
  not-ported part is recorded with a reason.
