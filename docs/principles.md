# Principles — what we build, and what we don't

The project's operating policy. `AGENTS.md` holds the engineering law; this is
the *what we do* on top of it. When a request is ambiguous, decide it here.

## What we do

- **We port the v2 TUI.** Everything a user can actually do in the TUI, the webui
  can do — the way the TUI does it, as a **real feature** with its behaviour
  (ordering, confirmations, grouping, defaults, empty states, live updates) —
  not a lookalike.
- **We build features, not endpoints.** A feature earns its way by being
  something a user does. Its endpoint comes along because the feature needs it.
- **We discover, then implement.** The checklist is the TUI's own command/binding
  registry — not the OpenAPI path list. We read v2 source, we match it.
- **We keep core native, extensions additive.** Anything native to opencode ships
  as **core**. Additive/non-native things ship as extensions. We dogfood the
  public extension API or it rots.
- **We record every skip.** If the web genuinely can't match (terminal-only
  mechanics) or we choose not to build something yet, it gets an explicit entry
  with a reason. Silence is a bug.
- **We measure.** Claims are things measured against the live engine or read from
  v2 source (`file:line`). Guesses are labelled as guesses.

## What we don't do

- **We don't wrap an endpoint because it exists.** Unused endpoints are not work.
  `reference/coverage.md`'s "genuine gap" rows are an inventory, not a backlog.
- **We don't stuff buttons to tick off routes.** An affordance that only displays
  is not a feature; a displayed-but-inert control is worse than an honest gap.
- **We don't fake parity.** No silent drop, no "roughly the same".
- **We don't absorb an extension into core "because it's easier."** Optional
  features ship as shipped extensions; core stays minimal.
- **We don't add a second way to do something that exists.** One method per
  concern — no second gate, loader, registry, or action surface.
- **We don't break contract ids silently.** Rename/move = version bump +
  migration note, same commit.

## How we decide a request

1. Can the v2 TUI do it, and does a user actually use it?
   → **It's parity work.** Find the v2 behaviour, match it, land it with its
     acceptance criteria.
2. Can the engine do it but the TUI doesn't surface it?
   → Usually **not** work. Wrap it only if a surface needs it; otherwise leave it
     client-only **with a reason**.
3. Is it web-impossible (terminal mechanics)?
   → **Record the non-goal** and the browser equivalent, then move on.

## Standing commitments (engineering)

These are kept short here; `AGENTS.md` is authoritative.

- The **store is the only place state lives**; recurring work goes through the
  one scheduler; components never fetch on their own.
- **Every new component self-registers** and renders through its `<Target>`.
- **Docs move with the code**; contract changes bump the version and regenerate
  the skill in the same commit.
- **The engine is out of scope** — we adapt client-side, we never change it.
- **The browser never holds engine credentials** — everything goes through the
  proxy.

## Non-goals

- **Terminal-only mechanics** — leader/chords, which-key, Kitty protocol, OSC-52,
  win32 FFI, renderer debug overlays. Browser equivalent, or recorded skip.
- **`opencode mini`** — a separate frontend, not a TUI route.
- **Breaking the engine contract** — no engine changes, no legacy-surface bridge.
- **Sandboxing extension code** — dropping a folder is an act of trust; say so
  plainly, don't fake safety.
