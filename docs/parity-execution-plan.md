# Parity execution plan — parallel build

How we build the TUI-parity phases, and how several agents can work at once
without colliding. **The roadmap (`docs/tui-parity-roadmap.md`) says *what* to
build. This file says *how, in what order, by whom, against which frozen
interfaces*.**

---

## 0. If you are a fresh agent, start here

You have none of the session context that produced this file. Read, in order:

1. `AGENTS.md` — the architecture and the **10 rules for editing**. Non-negotiable.
2. `docs/coverage.md` — the per-route have/don't-have map, incl. the
   "wrapped but not surfaced" audit.
3. `docs/tui-parity-roadmap.md` — the phases (P0–P7) and why P1/P5 were dropped.
4. **This file** — your wave, your file ownership, your acceptance criteria.
5. Your brief in §5 (Wave 1 units) if you are a Wave 1 agent.

### The 60-second orientation

This repo is a **browser frontend for the OpenCode v2 engine** — React + Vite,
a Bun proxy (`server/index.ts`) in front of the engine, and a single central
store (`src/store.ts`). The proxy speaks **only** `/api/*` to the engine and
that is **correct**: `@opencode/client` on branch `v2` declares 115 endpoints
and all 115 are `/api/*`. The engine also serves a *legacy unprefixed* surface
(`/lsp`, `/session/{id}/todo`, …) — that exists for the **v1** TUI and is **out
of scope here**. Do not add a passthrough for it. Do not reintroduce todos, LSP
status, session share, console orgs, pins or quick-slots: v2 has no endpoints
for any of them (see the "Dropped" table in the roadmap).

The engine this repo talks to reports **2.0.3**.

---

## 1. Ground truth (verify, don't re-derive)

Everything here was measured. If something looks wrong, re-measure before
building on it — but do not re-open settled questions.

| Fact | How to verify |
| --- | --- |
| Engine version | `bun -e 'import {Service} from "@opencode-ai/client/service"; const ep=await Service.ensure(); const r=await fetch(ep.url+"/api/health",{headers:Service.headers(ep)}); console.log((await r.json()).version)'` → `2.0.3` |
| Proxy forwards only `/api/*` | `server/index.ts`, the `if (path.startsWith("/api"))` branch |
| v2 client is 100% `/api/*` | in the v2 extraction: `grep -oE 'path: \`[^\`]+\`' packages/client/src/promise/generated/client.ts \| sed 's/path: `//;s/`//' \| sort -u` → 115 unique paths, **all** starting `/api/` |
| v2 has no todo/lsp/formatter/share/question endpoints | same file, grep those words → 0 |
| Contract drift | `bun run scripts/diff-openapi.ts --check` (exit 1 on drift) |
| TUI branch layout | `/home/zowail/opencode-reference` — `dev` = v1 (default), `v2` = the rewrite, `2.0` = dead April exploration |

**Reference checkout caveat.** `/home/zowail/opencode-reference` is a **shallow,
single-branch clone of `dev`** — i.e. the **v1 line**. The v2 branch was fetched
into `refs/remotes/origin/v2`. v2 source was extracted to
`/tmp/opencode/oc-v2/packages/{tui,client,schema,cli}` — **/tmp is ephemeral**;
if it's gone, re-create it:

```bash
mkdir -p /tmp/opencode/oc-v2
cd /home/zowail/opencode-reference && \
  git archive origin/v2 packages/tui packages/client packages/schema packages/cli \
  | tar -x -C /tmp/opencode/oc-v2
```

A previous inventory was taken from `dev` and was therefore **wrong**. Never
inventory the "TUI" from `dev` again.

---

## 2. Current state

**P0 (contract sync) is committed** as `31aefe3`:

```
feat(api): sync contract layer to upstream snapshot (116 -> 123 paths)
```

It landed `docs/reference/openapi.json` (116 → 123 paths), `src/api/client.ts`
(+new methods +types), `src/api/types.ts` (`PermissionRuleset`,
`MessageTypeFilter`) and the `docs/coverage.md` corrections. `typecheck` and
`build` were green at that state and `diff-openapi --check` reported no drift.

**Wave 1 can start from `HEAD`.** Sanity-check before you begin:

```bash
git status --short          # should be clean (or only your own new files)
bun run typecheck           # must be clean
bun run scripts/diff-openapi.ts --check   # must exit 0
```

> If the tree is dirty with someone else's work, **stop** — Wave 1 agents branch
> from `HEAD`, and an inherited dirty tree makes every diff unreadable and
> breaks worktree/stash isolation. That was the original blocker here; don't
> recreate it.

---

## 3. Execution model — and why waves

AGENTS.md rule 2: **"Keep the store as the only place state lives."**
`src/store.ts` is one 4.4k-line file and one reducer. Every phase that adds
state must edit it. **That single file is the serialization point and the
ceiling on parallelism.**

Contention map — read this before proposing a parallel split:

| Phase | New files (parallel-safe) | Contended core files |
| --- | --- | --- |
| P2 diff viewer | `DiffViewer.tsx`, `lib/sessionDiff.ts` | `FileExplorer.tsx`, `store.ts`, `registry.tsx` |
| P3 worktrees | `WorktreePanel.tsx` | `WorkspacePicker.tsx`, `store.ts` |
| P4 plugins | `settings/PluginsSection.tsx` | `SettingsDialog.tsx` |
| P4 permission rules | `PermissionRulesEditor.tsx` | `store.ts`, `SessionMenu.tsx` |
| P4 MCP / credentials | — | `McpIndicator.tsx`, `settings/IntegrationsSection.tsx` |
| P6 stash | `lib/stash.ts`, `StashPanel.tsx` | `Composer.tsx`, `store.ts` |
| P6 timeline | `TimelinePanel.tsx` | `Conversation.tsx`, `store.ts` |
| P6 frecency | `lib/frecency.ts` | `FilePicker.tsx` |
| P7 debts | — | `store.ts`, `FileExplorer.tsx`, `scheduler.ts` |

`store.ts` appears 5×; `FileExplorer.tsx` twice (P2 **and** P7); `Composer.tsx`
twice. **Parallel agents on overlapping files do not parallelize** — they
serialize on merge conflicts. So we invert: freeze the shared seams first, then
parallelize only the parts that touch nothing shared.

| Wave | Who | Runs | Output |
| --- | --- | --- | --- |
| **0** | Coordinator | serial, one pass | frozen store slices + selectors/actions + registered targets + `data-oc-*` anchors + entry-point placeholders |
| **1** | 4–5 agents | **parallel**, disjoint files | self-contained components/libs, new files only |
| **2** | Coordinator | serial | wire entry points, resolve mismatches, typecheck/build/live smoke |
| **3** | independent agents | parallel | verification / review per phase |

### File-ownership rules (hard)

1. A Wave 1 agent edits **only the files listed in its brief**. Nothing else.
2. If you need a change in a coordinator-owned file (`store.ts`, `App.tsx`,
   `registry.tsx`, `slots.tsx`, `Composer.tsx`, `Conversation.tsx`,
   `FileExplorer.tsx`, `SettingsDialog.tsx`, `WorkspacePicker.tsx`,
   `McpIndicator.tsx`, `SessionMenu.tsx`, `FilePicker.tsx`,
   `settings/IntegrationsSection.tsx`), **do not edit it** — write in your
   summary exactly what you need and the coordinator applies it in Wave 2.
3. Never edit `docs/reference/openapi.json` by hand. It is generated by
   `bun run scripts/fetch-openapi.ts`.
4. Never edit `src/api/client.ts` or `src/api/types.ts` in Wave 1 — P0 froze
   them. If an endpoint is missing, escalate.

---

## 4. Wave 0 — the seam (coordinator, serial)

**Deliverable:** one commit that adds every shared surface the Wave 1 units
code against, so no Wave 1 agent has to touch a shared file.

Contents:

1. **Store slices** for P2/P3/P6 — state + selectors + actions, following the
   existing `useStore((s) => ...)` pattern. Nothing renders yet.
2. **Registered targets** for each new unit (via the auto-registration /
   `<Target>` mechanism in `src/extensions/registry.tsx`), so the components are
   wrappable from day one (AGENTS.md: "Every new component must self-register").
3. **`data-oc-*` anchors** on the new mount points.
4. **Entry-point placeholders** in the coordinator-owned files (an empty
   `<Target id="…" />` or a commented slot) so Wave 2 is wiring, not invention.

### Frozen interface contract

Wave 0 freezes this. If the shipped code differs from what's written here,
**Wave 0's commit is authoritative** and the coordinator updates this table.

| Unit | Receives (props / store reads) | Emits (callbacks / store actions) |
| --- | --- | --- |
| **U1** DiffViewer | `files: FileDiffInfo[]`, `source`, `loading`, `error` | `onSelectSource(source)`, `onClose()` |
| **U2** PluginsSection | `plugins: PluginInfo[]`, `busy`, `error` | `onCheck(target?)`, `onUpdate(targets)`, `onToggle(id, disabled)` |
| **U3** PermissionRulesEditor | `rules: PermissionRuleset` | `onSave(rules)`, `onCancel()` |
| **U4** StashPanel / frecency | stash list; `query` | `onPop(entry)`, `onDelete(entry)`; frecency is a pure lib |
| **U5** WorktreePanel | `worktrees: WorktreeDirectory[]`, `busy`, `error` | `onCreate(input)`, `onRemove(input)`, `onRefresh()` |

**Rule:** units are **presentational**. They never call `api.*` directly — the
coordinator owns side effects in the store. (Exception: U4's frecency lib is
pure and takes/returns plain data.)

---

## 5. Wave 1 — parallel units

All units: **new files only**, against the frozen interface, no new dependencies,
Tailwind utilities with `var(--…)` tokens (never hardcoded hex), components-only
exports (a non-component export in a component file **disables React Fast
Refresh for the whole file** — keep helpers in `src/lib/`), and `bun run
typecheck` clean before you report.

### U1 — Turn-scoped diff viewer (P2) · highest value

**Files you own:** `src/components/DiffViewer.tsx`, `src/lib/sessionDiff.ts`
(create; nothing else).

- Reuse `src/components/DiffView.tsx` (`parseDiff`, `DiffView`). **Do not write a
  second diff renderer.**
- Three sources, matching v2 (`feature-plugins/system/diff-viewer*.tsx` on
  `origin/v2`): working tree, branch base, **last turn**.
- The last-turn source is `api.sessionDiff(sessionID, { from?, to?, context? })`
  → `FileDiffInfo[]` (`{ file, patch, additions, deletions, status }`), already
  wrapped and smoke-tested live. Turn-scoped: idle-marker to idle-marker, so
  steered prompts fold into one turn.
- Needs: source switcher, file tree, per-file and per-hunk navigation, split vs
  unified, mark-reviewed (local only).
- **Acceptance:** a completed turn's diff matches `git diff` for the same range;
  a steered-prompt turn appears as one turn; no renderer duplication.
- Reference for behaviour: `/tmp/opencode/oc-v2/packages/tui/src/feature-plugins/system/diff-viewer.tsx`.

### U2 — Plugins settings section (P4)

**Files you own:** `src/components/settings/PluginsSection.tsx` (create).

- Consumes `PluginInfo` (`{ id?, source, features, state }`) — note `source` is
  the key, `id` is optional.
- Actions the engine supports (all verified live): `pluginCheck(target?)`,
  `pluginUpdate(targets)`, `pluginAwaitActivation()` (204, may be slow — it waits
  for activation to settle, incl. installing missing packages).
- Show: source kind (`builtin` / `package`+`target`+`version` / `local` /
  `sdk`), `features` (server/tui/rpc), `state` (`active` | `failed`+`error`),
  and an **"update available"** affordance driven by
  `source.outdated`/`source.updating` on package entries.
- **This replaces a deliberately-removed informational tab.** It must *act*, not
  display. No read-only config dump.
- **Acceptance:** typecheck clean; renders all four source kinds and the failed
  state; builds against the frozen interface without touching `SettingsDialog.tsx`.

### U3 — Permission rules editor (P4) · highest-value item in P4

**Files you own:** `src/components/PermissionRulesEditor.tsx` (create).

- Model: `PermissionRuleset = PermissionRule[]`, `PermissionRule =
  { action: string; resource: string; effect: "allow" | "deny" | "ask" }`
  (frozen in `src/api/types.ts`).
- Persisted by `api.sessionPermissionRules(sessionID, rules)` → **204, replace
  semantics** (not a merge). Session rules evaluate **after** the agent's rules
  and **the last matching rule wins** — the UI must make ordering legible
  (reorderable rows).
- `action`/`resource` are glob-ish strings; `resource: "*"` is valid.
- **Acceptance:** add/remove/reorder rows; all three effects; save is a single
  PUT; typecheck clean.

### U4 — Prompt stash + frecency (P6)

**Files you own:** `src/lib/stash.ts`, `src/components/StashPanel.tsx`,
`src/lib/frecency.ts` (create).

- Mirror v2 (`prompt/stash.tsx`, `component/dialog-stash.tsx`,
  `prompt/frecency.tsx` on `origin/v2`): stash = **50-entry cap**, pop/list/delete.
- Persistence: follow the existing per-session localStorage pattern in
  `src/lib/drafts.ts`. Do **not** invent a new persistence layer.
- `frecency.ts` is **pure** (score/order given usage records) — no DOM, no
  storage, so it is unit-testable. `@`-mention ordering is the consumer.
- **Acceptance:** stash survives reload, cap enforced, pure lib has no imports
  from `store.ts` or React.

### U5 — Worktree panel (P3) · optional, do last

**Files you own:** `src/components/WorktreePanel.tsx` (create).

- Consumes `WorktreeDirectory` (`{ directory, strategy? }`); actions via
  `api.worktreeList/Create/Remove/Refresh` (already wrapped; remove requires
  `force`).
- `worktreeCreate` **runs the project's setup script** — never block the UI on
  it; show progress and assume it can take minutes.
- Location-scoped; pass `location[directory]` via the existing `vcsQuery`
  helper convention.
- **Acceptance:** list/create/remove/refresh render; refresh reconciles.

---

## 6. Wave 2 — integration (coordinator, serial)

1. Apply every "I need this in a shared file" request from the Wave 1 summaries.
2. Wire entry points: `FileExplorer.tsx` (P2), `Composer.tsx` (stash/frecency),
   `Conversation.tsx` (timeline), `SettingsDialog.tsx` (plugins),
   `SessionMenu.tsx` (permission rules), `WorkspacePicker.tsx` (worktrees),
   `McpIndicator.tsx` / `settings/IntegrationsSection.tsx` (MCP write ops,
   credentials).
3. Resolve interface mismatches **in the store**, not in the unit.
4. Gates: `bun run typecheck` → `bun run build` → live smoke-test every new
   route → `bun run scripts/diff-openapi.ts --check` → extension battery if the
   contract was touched.
5. Update `docs/coverage.md` (route → client → UI, or client-only **with a
   reason**) in the same commit.

**Live smoke-test pattern** (test mutating routes on a throwaway session and
delete it — never touch a real one):

```bash
bun -e '
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const h = { ...Service.headers(ep), "content-type": "application/json" };
const r = await fetch(`${ep.url}/api/session`, { method:"POST", headers:h,
  body: JSON.stringify({ title:"dev smoke - delete me", location:{ directory: process.cwd() } }) });
const sid = (await r.json()).data.id;
// ... exercise the route against `sid` ...
await fetch(`${ep.url}/api/session/${sid}`, { method:"DELETE", headers:h });
'
```

---

## 7. Wave 3 — verification (parallel)

One independent agent per completed phase, each checking against the **roadmap's
acceptance criteria**, not the implementer's summary. Wave 1 agents must not
verify their own unit.

---

## 8. Conventions every agent must follow

From `AGENTS.md` — the ones Wave 1 breaks most often:

- **No new dependencies.** Approved surface: React, react-markdown, shadcn/ui
  (vendored), Radix (vendored), lucide-react, Tailwind; exceptions already
  approved: `@shadcn/react`, `@xterm/xterm` + addon-fit. A new dep needs
  justification.
- **Component files export COMPONENTS ONLY.** A runtime non-component export
  kills Fast Refresh for the file. Put helpers in `src/lib/`.
- **Styling:** Tailwind v4 utilities + `var(--…)` tokens from `src/styles.css`.
  **Never hardcode hex.** New components should not add new CSS.
- **The store is the only place state lives.** Components read via
  `useStore((s) => ...)`; no component-owned `setInterval` — recurring work goes
  through `src/lib/scheduler.ts`.
- **Every new component self-registers**, and rich props / consulted services
  beat baked-in values.
- **Contract ids are contract:** target ids, collection ids, service ids,
  `data-oc-*` anchors, manifest fields. Renaming any of them = version bump plus
  a migration note in the same commit.
- **Docs move with the code.** Contract-relevant changes update the authoring
  guide, the rule set and `skills/webui/SKILL.md` in the same commit.
- **Hot reload:** editing `src/**` applies instantly; editing `server/index.ts`
  restarts the proxy (drops the SSE stream, reconnects by itself). **Never
  restart the opencode service for UI work.**

Gate command for every unit:

```bash
bun run typecheck      # must be clean
bun run build          # must succeed
```

---

## 9. Corrections a fresh agent must not undo

These were wrong earlier in the project's life and are now settled. Do not
"fix" them back:

- **Do not describe the Settings tabs for Plugins / WebSearch / Config / Server
  as having "never existed."** They existed and were **deliberately de-surfaced**
  as purely informational. (The original P0 commit message said otherwise; the
  wording was corrected before the commit landed as `31aefe3`.)
- **Do not claim the TUI is "mid-migration" or "behind v2."** The v1/v2 split is
  a branch split (`dev` vs `v2`), and an earlier inventory was taken from the
  wrong one.
- **Do not add a legacy-surface proxy bridge.** `server/index.ts` forwarding only
  `/api/*` is correct.
- **Do not reintroduce P1 or P5** (legacy bridge; todos, LSP/formatter status,
  session share, console orgs, upgrade). Not v2 capabilities.
- **Do not port terminal chrome** (which-key, tips, renderer, OSC-52 clipboard,
  Kitty keyboard, win32 FFI). Browser equivalents already exist.
- **Session tags do not exist** on either side. `dialog-tag` on `dev` is a
  *filename* autocomplete dialog.

---

## 10. Handoff protocol

A Wave 1 agent reports back with exactly:

1. **Files created** (paths).
2. **Interface deltas** — anything the frozen contract could not express.
3. **Changes needed in coordinator-owned files** — file, symbol, exact change.
4. **Verification** — `typecheck` / `build` output, plus what was manually
   exercised.
5. **Open questions / risks.**

If blocked, **stop and report**. Do not widen your file ownership to get
unblocked — that is what causes the merge conflicts this plan exists to avoid.

---

## 11. Ordering

Waves are the plan. If you want value sooner with less ceremony, **P2 (U1) alone,
serially, first** — it is the validated highest-value gap, its store slice is
small, and it becomes the template other units copy, which measurably improves
Wave 1 quality. U5 (worktrees) is the most droppable.
