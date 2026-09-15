# TUI parity port plan — reach full port parity

**This is the hand-off document.** It states the goal, the exact remaining work,
and how to build it (waves, ownership, sub-agent briefs, gates). It is the
successor to `docs/parity-execution-plan.md`, which covered the now-committed
P0–P7 program.

Read order for a fresh agent: **`AGENTS.md` (the 10 rules — non-negotiable) →
`docs/coverage.md` → `docs/tui-parity-roadmap.md` → this file → your brief.**

---

## 1. The goal (verbatim intent — do not reinterpret)

> **The webui must be able to do everything the v2 TUI can do, the way the TUI
> does it — a web port, not a loosely-inspired frontend. If something exists in
> the API but is unused, that is fine; no need to use it.**

Decoded into engineering terms:

1. **Capability parity.** Every user-facing thing the v2 TUI can do, the webui
   must be able to do. The TUI's own command/binding registry is the checklist
   (see §2.3) — not the OpenAPI path list.
2. **Behavioural fidelity.** Where the TUI does something in a specific way
   (ordering, confirmation steps, grouping, defaults, empty states, live
   updates), match it. "We have something similar" is not parity.
3. **Unused endpoints are NOT work.** Do *not* wrap an endpoint because it
   exists. `docs/coverage.md`'s "genuine gap" rows are an inventory, not a
   backlog. Wrap what a surface needs and nothing else.
4. **Where the web genuinely cannot match, say so explicitly** in the docs, and
   record the reason — never fake it or silently drop it.

### Explicit non-goals

- **Terminal-only mechanics** — leader/timed chords, which-key panel, Kitty
  keyboard protocol, OSC-52 clipboard, win32 FFI, terminal suspend/title,
  renderer debug overlay/console, heap snapshot, storybook, scrap, the Zed
  SQLite editor bridge, the simulation-semantics harness. These exist *because
  it is a terminal*; the browser equivalent (`xterm`, Web Notifications, OS
  clipboard, DevTools) is the port. List any you decide to skip in the
  coverage table with this reason.
- **`opencode mini`** — a *separate frontend* (`src/mini/`), not a TUI route. A
  web port of it is a separate project. Out of scope unless the human asks.
- **Breaking the engine contract** — we are a client. No engine changes, no
  legacy-surface bridge (see §3).

---

## 2. Ground truth (verify, don't re-derive)

| Fact | How to verify |
| --- | --- |
| Engine version is **2.0.3** | `bun -e 'import {Service} from "@opencode/client/service"; const ep=await Service.ensure(); const r=await fetch(ep.url+"/api/health",{headers:Service.headers(ep)}); console.log((await r.json()).version)'` |
| Client dependency is **`@opencode/client@2.0.3`** (v2 line) | `grep opencode/client package.json` — note it is **not** `@opencode-ai/client` any more (that was a dev-scope prerelease; P7 migrated it) |
| Proxy forwards only `/api/*` — correct as-is | `server/index.ts`, the `if (path.startsWith("/api"))` branch |
| Contract drift | `bun run scripts/diff-openapi.ts --check` (must exit 0) |

### 2.1 The v2 reference source

`/tmp/opencode/oc-v2/packages/{tui,client,schema,cli}` is an extraction of
branch `origin/v2`. **`/tmp` is ephemeral** — re-create it if missing:

```bash
mkdir -p /tmp/opencode/oc-v2
cd /home/zowail/opencode-reference && \
  git archive origin/v2 packages/tui packages/client packages/schema packages/cli \
  | tar -x -C /tmp/opencode/oc-v2
```

Note: `/tmp/opencode/oc-v2` contains only those four packages. The workspace
deps `@opencode/merman`, `@opencode/latex`, `@opencode/plugin`, `@opencode/theme`
are **not present** and **not on npm** — for those, the TUI's own usage is the
spec (see R2).

### 2.2 Provenance rule (from the roadmap, still binding)

Only two kinds of claim belong in these docs: things **measured** against the
live engine, and things **read from v2 source** (cite `file:line`). Everything
else is an unverified guess and must be labelled as such. The `file:line`
references in this document come from a source read on 2026-09-15 — **re-open
the file before you build on one**; the extraction can be refreshed and lines
drift.

### 2.3 The capability checklist

The TUI's capability list is its command/binding registry, not the API surface:

- `packages/tui/src/config/keybind.ts` — every bindable command id + default key + description (the authoritative table).
- `packages/tui/src/app.tsx` — `appCommands()` registers the app-level ones with `slash` aliases and `palette` visibility.
- Areas: `routes/`, `component/prompt/`, `component/session-frame.tsx`, `ui/dialog-*.tsx`, `feature-plugins/**`.
- A raw dump of every dotted id (424, mostly tree-sitter **syntax scopes** — filter those out) can be regenerated with:
  ```bash
  cd /tmp/opencode/oc-v2/packages/tui/src && \
    grep -rhoE '"[a-z][a-z0-9]*(\.[a-z0-9_]+)+"' --include=*.ts --include=*.tsx . \
    | tr -d '"' | sort -u
  ```

### 2.4 Gates (every unit, no exceptions)

```bash
bun run typecheck                                   # must be clean
bun run build                                       # must succeed
bun run scripts/diff-openapi.ts --check             # must exit 0
```

Plus, for anything touching the extension contract or store wiring:

```bash
bun run scripts/uitest/ext-battery-browser.ts       # 34 checks
bun run scripts/uitest/ext-battery-dom.ts           # 10
bun run scripts/uitest/ext-battery-proxy.ts         # 17
bun run scripts/uitest/ext-battery-acceptance.ts    # 15
bun run check:setup                                 # 50
bun run check:config                                # 38
```

Live smoke-test pattern for mutating routes — **always on a throwaway session**,
never a real one:

```bash
bun -e '
import { Service } from "@opencode/client/service";
const ep = await Service.ensure();
const h = { ...Service.headers(ep), "content-type": "application/json" };
const r = await fetch(`${ep.url}/api/session`, { method:"POST", headers:h,
  body: JSON.stringify({ title:"dev smoke - delete me", location:{ directory: process.cwd() } }) });
const sid = (await r.json()).data.id;
// ... exercise the route against `sid` ...
await fetch(`${ep.url}/api/session/${sid}`, { method:"DELETE", headers:h });
'
```

Two live-system notes for a fresh agent:

- `bun run dev` = dev proxy (4098) + Vite (5173). **Use 5173 for browser checks.**
  `:4097` is the *globally installed* older build — do not confuse them, and do
  not restart the opencode service or touch the user's `:4097`.
- A **pre-existing** console error `[extensions] wrap "brother-agent-row|header"
  crashed … React #310` comes from the external user extension
  `~/.config/opencode/webui-extensions/brother-agent/` (conditional hooks). It
  reproduces on `:4097`. Do not attribute it to your work; fixing it is not part
  of this plan.

---

## 3. Corrections a fresh agent must not undo

These were wrong or incomplete earlier and are now settled by measurement.
Do not "fix" them back.

### 3.1 Corrections to the roadmap's own claims (verified 2026-09-15)

- **Pins + quick slots DO exist in v2** and are parity targets (R3).
  `session.pin.toggle` is a registered action with default `ctrl+f`
  (`component/dialog-session-list.tsx:250`, `config/keybind.ts:136`);
  `session.quick_switch.1..9` are live bindings (`app.tsx:129-139`) read by the
  session list (`dialog-session-list.tsx:128-129`). The roadmap's "Dropped" row
  said the opposite; it has been corrected in place.
- **Which-key is v2, not `dev`-era** (`config/keybind.ts:286-288`). It is still
  *optional* to port — a terminal leader/chord affordance — but do not describe
  it as "not a v2 feature".
- **`Vcs.Mode` is `working | branch | committed`** per the frozen snapshot; our
  `VcsMode` type only has the first two, so a supported mode is unreachable
  from the UI (R7).
- **Session tags still do not exist** on either line (0 hits in `origin/v2`).
- **`dialog-console-org` is `dev`-only** (0 hits in `origin/v2`).
- **`todo` / `lsp` / `formatter` / `share` have no v2 client route** — correctly
  dropped.

### 3.2 Things that must stay as they are

- **Do not add a legacy-surface proxy bridge.** `server/index.ts` forwarding
  only `/api/*` is correct: the v2 client is 100% `/api/*`.
- **Do not reintroduce P1/P5** as "phases" — they were dropped for cause.
- **Do not wrap endpoints for their own sake** (§1.3).
- **The store is the only place state lives** (AGENTS rule 2). Components read
  via `useStore((s) => ...)`; recurring work goes through `src/lib/scheduler.ts`;
  no component-owned `setInterval`.
- **Component files export COMPONENTS ONLY.** A runtime non-component export
  kills React Fast Refresh for the file. Helpers go in `src/lib/`.
- **Never hardcode hex.** Tailwind v4 utilities + `var(--…)` tokens from
  `src/styles.css`.
- **Every new component self-registers** (`autoRegister`) **and is rendered
  through `<Target id>`** — registering without a `<Target>` call site means
  wraps/replaces silently do nothing (that exact bug exists today; see R0).
- **Contract ids are contract** (target ids, collection ids, service ids,
  `data-oc-*` anchors, manifest fields). Renaming/moving any = version bump +
  migration note in the same commit.
- **Docs move with the code**: the authoring guide
  (`webui-extensions/README.md`), `docs/extension-system-spec.md`, and
  `skills/webui/SKILL.md` in the same commit.

### 3.3 What already landed (do not rebuild)

P0–P7 are committed: contract sync; the Wave 0 store seam; the turn-scoped diff
viewer; worktrees; actionable settings (plugins / permission rules / MCP
add-remove / credential relabel-delete); prompt stash + `@`-mention frecency;
and the P7 debts (interrupt truthfulness, `contextMenu.file` consumer, client
migration to `@opencode/client@2.0.3`).

**P6 is partial**: stash + frecency landed; **timeline** and **directory
recents** did not (they are R4 and R8 here). **Shell selection (P4) is
deferred** — no settings host exists for a global preference (R12).

Current shape you can rely on:

- **Core targets (26)**: `composer*`, `sidebar*`, `tool.*`, `message.*`,
  `conversation*`, `diff.viewer`, `stash.panel`, `worktree.panel`,
  `settings.plugins`, `permission.rulesEditor`.
- **Slots (5)**: `conversation.header.actions`, `conversation.empty`,
  `composer.above`, `composer.actions`, `sidebar.header.actions`.
- **Global hotkeys**: `Ctrl+N`, `Ctrl+\`, `Ctrl+P`, `Ctrl/⌘+F`, `Esc`
  (two-step interrupt), arrows (session/subagent navigation). Composer-owned:
  `Enter` steer / `Ctrl/⌘+Enter` queue, `Ctrl+B` background subagents,
  `Ctrl+S` stash, `Tab` agent cycle.

---

## 4. What's left

Sized S (hours) / M (a day-ish) / L (multi-day) / XL (a program of its own).
**Everything here needs the human's sign-off before you start** — the plan is
the spec; §8 lists the open decisions.

### R0 — Ship defects (serial, first, small) · S

Live bugs in what already shipped. Fix these before new work so the tree is
honest.

| # | Defect | Fix |
| --- | --- | --- |
| R0.1 | The `/diff` slash command says "Open diff viewer" but runs `signalUI("explorer")` (`Composer.tsx:621-625`), which opens the **FileExplorer** — the actual viewer is only reachable via FileExplorer → Review | Point `/diff` at `openDiffViewer(sessionID)`; keep a separate command (or none) for the explorer |
| R0.2 | `settings.plugins` and `permission.rulesEditor` call `autoRegister` but are imported/rendered **directly** (`SettingsDialog.tsx:362`, `SessionMenu.tsx:107`) — no `<Target>` call site, so wraps/replaces on them do nothing | Render them through `<Target id>` with props, like `diff.viewer`/`stash.panel` |
| R0.3 | `VcsMode = "working" \| "branch"` drops the contract's `committed` | Add `committed` to the type (contract-layer, justified by the snapshot) — then R7 uses it |
| R0.4 | `HelpDialog` omits real bindings: `Ctrl+S` (stash), `Ctrl+\` (split), `Ctrl+K` (kill shell), `Ctrl/⌘+Enter` (queue) | Add them |
| R0.5 | `InboxPanel.tsx` is dead code — never imported/mounted (pre-existing) | Either mount it or delete it; `docs/coverage.md` implies it is live |
| R0.6 | AGENTS.md said Settings has three tabs (it has four) | **Already fixed in this commit** |

### R1 — Markdown rendering pipeline (syntax highlighting) · L

**This is the biggest single parity divisor: it affects every code block.**

| v2 | us |
| --- | --- |
| Tree-sitter WASM highlighting, ~30 configured grammars + builtins (`src/parsers-config.ts`, registered via `addDefaultParsers`), fallback = plain unhighlighted text for unknown languages | `react-markdown` + `remark-gfm` only. **No syntax highlighter at all in `package.json`** — every code block, `write`/`read` preview and shell output is plain text |

**Deliverable:** a `CodeBlock` renderer used by every markdown surface (message
text, compaction summaries, tool cards), with a language → highlighter-theme
mapping driven by our CSS tokens, graceful plain-text fallback, and lazy
loading so the initial bundle doesn't pay for it (`main.tsx` already warms
chunks on idle — reuse that idiom).

**Acceptance:** a fenced block in a real assistant message is highlighted; an
unknown language renders as plain text, not an error; the bundle grows only in
a lazy chunk; typecheck/build green.

**Blocked on:** the highlighter dependency decision (§8.1).

### R2 — Diagrams + math (mermaid, LaTeX) · M

**The most visible divergence in the transcript.**

| v2 | us |
| --- | --- |
| `@opencode/merman` + `@opencode/latex` are **builtin plugins** (`plugin/builtins.ts:11-12`) that register **markdown code-block renderers** keyed by the fence info-string (`plugin/api.tsx:130-140`). A ` ```mermaid ` fence is *drawn* (node labels visible), a ` ```latex ` fence is *transformed to glyphs* — the fence markers, language keyword and source are all hidden. This applies wherever `<markdown>` is used, **including compaction summaries** (proven by `test/app-lifecycle.test.tsx:533-637`). Renderers are crash-isolated (`plugin/render.tsx:26-46`) | A ` ```mermaid ` block renders as a plain code fence. Nothing renders diagrams or math |

**Deliverable:** `MermaidBlock.tsx` + `LatexBlock.tsx` (new files) wired into
the same markdown pipeline as R1. Lazy-load `mermaid` on first diagram; `katex`
for math. Hide the source and the fence chrome, exactly as v2 does.

**Acceptance:** a message containing ` ```mermaid ` (flowchart + subgraphs —
v2's own fixtures are in `storybook/merman-layouts.tsx:9-119`) draws a diagram
with visible node labels; ` ```latex ` shows rendered glyphs, not `x^2`; the
same works inside a compaction summary; a renderer that throws does not blank
the transcript.

**Blocked on:** the mermaid/katex dependency decision (§8.1).
**Note:** do NOT build the extension-facing `registerCodeBlockRenderer` API
first. Get the built-ins working through the core pipeline, then expose the
registration (R13) — contract surface last, not first.

### R3 — Session tabs + pins/quick-slots · L

v2's primary workspace chrome. We have split view (which v2 lacks) — **add
tabs, do not replace split view** (§8.2).

| v2 | us |
| --- | --- |
| Horizontal/vertical **tab rail** (`component/session-tabs.tsx`, `session-tabs-rail.tsx`): number cell, title shimmer, hover marquee for overflow. Per-tab indicators: `!` permission, `?` question, spinner while busy, unread dot, error colour, completion pulse, attention glow. Middle-click close; drag-reorder (one persisted move on release); right-click menu (New/Rename/Close); close/reopen with a 10-entry stack; `session.tab.next/previous/next_unread/previous_unread/close/reopen/select.1..10` (`app.tsx:771-824`); compact one-letter mode with a hover tooltip. When tabs are disabled, **pins** take over: `session.quick_switch.1..9` (`app.tsx:129-139`) with quick-slot numbers in the session list gutter (`dialog-session-list.tsx:128-129`) and `session.pin.toggle` (`ctrl+f`) | Split panes (≤3) + a title dot for live. No tab rail, no per-tab status, no reorder, no close/reopen stack, no select-by-number, **no pins or quick slots** |

**Deliverable:** `SessionTabs.tsx` (+ a rail variant), a tab model in the store
(open tabs, order, unread/attention state, closed stack), the tab commands and
bindings, and pins/quick-slots in the sidebar session rows.

**Acceptance:** open 5 sessions as tabs; `!` appears on a tab whose session has
a pending permission; middle-click and right-click behave as described; close
then reopen restores position; `1..9` switches tabs (or pinned sessions when
tabs are off); reload preserves the tab set; split view still works.

### R4 — Timeline + Message Actions · M

| v2 | us |
| --- | --- |
| `/timeline` (`session.timeline`, `<leader>g`) opens a dialog of all **user messages, newest first, with time footers**; moving the selection **jumps the transcript live**; Enter opens **Message Actions** (`routes/session/dialog-message.tsx`): Jump to / Revert (undo messages + file changes, seeds the prompt) / Copy text / Fork | Nothing (this is the P6 remainder). We have a right-side user-message rail and global search |

**Deliverable:** `TimelineDialog.tsx` (new file) + the store slice it needs
(selected index → scroll target). Reuse the existing highlight/scroll machinery
(`setHighlightMessage`) for the live jump.

**Acceptance:** opening the timeline lists every user message newest-first with
relative times; arrowing down scrolls the transcript to that message without
closing the dialog; Enter exposes Jump/Revert/Copy/Fork and each works.

### R5 — Notifications / attention · M

| v2 | us |
| --- | --- |
| `feature-plugins/system/notifications.ts` + `attention.ts`: on **turn end** (subagent-aware), **error**, **permission asked** and **form created** → an OS notification (default **when blurred**) and a per-event sound, de-duplicated by id. Config `attention.{enabled,notifications,sound,volume,sound_pack,sounds}`; **`enabled` defaults to `false`**. Subagent sessions suppress the notification but still play the sound. Failed MCP servers raise a toast with an "Open MCP servers" action | Toasts (`Toasts.tsx`), run notices (`RunNotices.tsx`), and a PWA live tile. **No OS notification on turn end, no sounds, no config** |

**Deliverable:** `lib/attention.ts` (new) wired to the store's existing derived
events (`run.ended`, `run.notices`, `permission.asked`, `form.created`), using
`Notification` + `Audio` behind a prefs gate. Web-appropriate when-to-fire
(it is a browser: "when the tab is hidden" is the analogue of "blurred").

**Acceptance:** with attention on, finishing a turn while the tab is hidden
raises one notification (not one per event); permission/form requests notify;
a subagent turn does not raise a notification but still plays its sound;
turning it off silences everything; no notification storm on reload.

**Blocked on:** the sounds decision (§8.3).

### R6 — Stats route · M

| v2 | us |
| --- | --- |
| `/stats` (`opencode.stats`, `feature-plugins/system/stats.tsx`) is a **full-screen plugin route**: year-to-date tokens as giant block digits, a GitHub-style activity calendar, best streak / active days / sessions, `opencode.ai` footer, loading + error states. Data = **`GET /api/experimental/session/stats`** (unwrap it), `{from: Jan 1, timezone, tools: "none"}` | Nothing. The endpoint is unwrapped |

**Deliverable:** `StatsPanel.tsx` + `lib/stats.ts` (new), the client method, and
a route/mount (our extension `pages` collection or a core dialog — see §8.4).

**Acceptance:** the numbers match a direct call to the endpoint; the calendar
renders a full year with month labels; loading and error states exist.

### R7 — Diff viewer completeness · M

The viewer exists; make it behave like v2's.

| Gap | v2 evidence |
| --- | --- |
| **"Committed" source** (base merge-base → HEAD) — unreachable today because `VcsMode` omits it | `Vcs.Mode` enum includes `committed`; v2's source list is All(branch) / Committed / Uncommitted / a chosen Base |
| **Base-branch picker** — a searchable local+remote branch list, remembered until the viewer closes; the source header reads `All · vs <base>` | `feature-plugins/system/diff-viewer.tsx:219-234` via `client.vcs.branches(...)` (`/api/vcs/branches`, unwrapped by us) |
| **Image previews** for `png/jpg/jpeg/webp/gif` in the patch pane, click to enlarge; committed images say unavailable; deleted images have their own note | `diff-viewer-image.tsx:9-11`, allowlist verified by `test/cli/tui/diff-viewer-image.test.tsx:17-24` |
| **Single-patch mode** (`s`), **toggle file tree** (`b`), **`d`** switch source, **`?`** shortcut help (`diff.help`) | `diff-viewer.tsx:635-694`; bindings `config/keybind.ts:79-88` |
| **Vim scroll keys**: `j/k`, page/half-page (`Ctrl+D`/`Ctrl+U`), `gg`/`G`, `]`/`[` hunk, `n`/`p` file | `config/keybind.ts:65-82` |
| **Per-file context menu**: mark complete / incomplete | `diff-viewer-file-menu.tsx` |

**Acceptance:** the source list matches v2's four; picking a base branch
re-renders and is remembered until close; an image change shows a thumbnail
that enlarges; every binding above works; `?` lists the shortcuts.

### R8 — Composer completeness · L

| Gap | v2 evidence |
| --- | --- |
| **Reject a permission *with a message*** — v2 opens a textarea ("Tell OpenCode what to do differently") and sends `message`; we always send `message: null` and have no UI | `routes/session/permission.tsx:284-307`; the reply body already supports `message` |
| **Directory completion + recents** — `~`, `~/`, `../`, absolute; per-project recents (≤10) prepended, with a destructive `ctrl+d` confirm to delete one; `tab` expands a directory | `prompt/directory-completion.ts`, `prompt/directory-recents.ts`, `prompt/autocomplete.tsx:740-760` |
| **`session.cd <dir>`** — takes an argument; moves the session or sets the **home** location for new sessions | `component/prompt/index.tsx:265-309` |
| **`@` references beyond files** — v2's reference autocomplete includes **agents, skills, MCP resources and reference aliases** as well as files; fuzzy + frecency boost, max 10 | `prompt/autocomplete.tsx:501-520` |
| **Large-paste collapse** — a big paste becomes `[Pasted ~N lines]`, click to expand; `app.toggle.paste_summary` | `component/prompt/index.tsx` extmark mentions |
| **`prompt.stash.pop`** as its own binding (pop the newest without opening the panel), and **two-tap delete** in the stash dialog (`stash.delete` = `ctrl+d`) | `component/prompt/index.tsx:884-899`, `dialog-stash.tsx:74-88` |
| **Editor handoff** (`/editor`) — see §8.5: this one may have no faithful web analogue | `component/prompt/index.tsx:548-578` |

**Acceptance:** rejecting a permission with a reason sends it (verify the
engine receives it); typing `~/` offers completions and recents; `/cd /tmp`
moves the session; `@` offers agents and skills as well as files; a 200-line
paste collapses.

### R9 — Transcript fidelity · L

| Gap | v2 evidence |
| --- | --- |
| **Reasoning grouping + per-block disclosure** — consecutive reasoning parts collapse into one row; `session.toggle.thinking` controls show/hide; reasoning text uses a **desaturated clone** of the syntax theme | `routes/session/grouping/session.ts:67-71`, `routes/session/thinking-syntax.ts:3-7`, `component/prompt` reasoning blocks |
| **Exploration grouping** — consecutive `read`/`glob`/`grep` tools collapse into one group (`session.toggle.exploration_grouping`) | `grouping/session.ts:67-71` |
| **Per-turn token usage** — a collapsible `+ Tokens: N steps · X new · Y cached · Z total` per turn, with an optional per-step table (`config.debug.turn_tokens`) | `routes/session/index.tsx:1479-1600` |
| **Tail-mount + backfill + per-session scroll anchor** — the last 40 rows mount, older ones backfill in chunks of 60 in both directions, and each session remembers its scroll position; "Jump to latest ↓" when scrolled up | `routes/session/index.tsx:124,379-453,1326-1344` |
| **Revert view detail** — a `RevertMessage` count plus the affected files | `routes/session/index.tsx:158-169,1315-1320` |
| **Copy variants** — copy last assistant message (`messages.copy`), copy session ID (`session.copy.id`) | `routes/session/index.tsx:1036-1088` |
| **Compaction message detail** — full-width rule + cancellation marker + `N in · M out` + the summary as markdown | `routes/session/index.tsx:2065-2131` |

**Acceptance:** a long turn's reasoning collapses to one row that expands;
consecutive greps group; the per-turn token line toggles; switching away and
back restores scroll position; copy-session-ID works.

### R10 — Tool card completeness · M

We have edit/write/shell/subagent/execute/read/grep/glob/webfetch/websearch/
generic. Missing, with v2 evidence:

- **`apply_patch` / `patch`** display (`routes/session/index.tsx:3355-3473`).
- **`question`** — a completed question renders a `# Questions` block listing each question and its answer (`:3475-3509`).
- **`skill`** — an inline `Skill "<name>"` row (`:3511-3518`).
- **Diagnostics** — up to 3 severity-1 errors under write/edit (`:3520-3544`).
- **Background shells** — poll `GET /api/shell/{id}/output` (cursor+limit, ANSI stripped, 1 MiB cap) while running, with a `Background` badge (`:2857-3007`).
- **Denied tools** get `STRIKETHROUGH` (rejected permission / dismissed question) (`:2669-2740`).
- **Collapse budgets** — shell collapses past 10 lines, execute past 4, plus a char budget (`util/collapse-tool-output.ts`).

**Acceptance:** each has a live or fixture-verified render; a big shell result
collapses with a working expand; a denied tool is struck through.

### R11 — Overlays & pickers · M

| Gap | v2 evidence |
| --- | --- |
| **Error details** dialog — scrollable error, optional source path + reference, `c` copy, **`i` investigate** (navigates home and seeds the prompt with a diagnostic prompt) | `component/dialog-error-details.tsx:79-86` |
| **Reconnecting** full-screen scrim (distinct from a stale dot) | `component/reconnecting.tsx` |
| **Update notification** — states checking/available/installing/installed/current/unavailable/failed, Skip/Update/Restart, de-duped so the same version does not re-notify; driven by client subscribe + server `installation.*` events | `component/dialog-update.tsx`, `context/update-notification.tsx` |
| **Debug** dialog — version/channel, date, OS, session ID, model; Enter copies all | `component/dialog-debug.tsx` |
| **Pairing** — "This device" URL, all URLs, username, masked password with reveal, **QR code** | `component/dialog-pair.tsx` |
| **Session list dialog** — server-side search (debounced), Pinned → Today → date groups, running spinner, quick-slot numbers, `ctrl+a` **all-projects** scope toggle, pin/unpin/delete/rename | `component/dialog-session-list.tsx` |
| **Open / recents picker** — sessions + projects; `→` drills into a project's **worktrees**; `ctrl+n` creates a worktree inline; current checkout dot | `component/dialog-open.tsx:38-493` |
| **Migration overlay** — polls v1 migration status (`n/total`) | `component/migration-overlay.tsx` — only matters if v1→v2 migration is in play |

**Acceptance:** each renders and its primary action works; the QR encodes the
public URL; the update notice does not re-fire for the same version.

### R12 — Settings & themes completeness · M

| Gap | v2 evidence |
| --- | --- |
| **Auto-accept permissions** (`session.permissions` = prompt/autoaccept) | `component/dialog-config.tsx` (Session group) |
| **Permission prompt fullscreen** toggle (`permission.prompt.fullscreen`, `ctrl+f`) | `routes/session/permission.tsx:440-496` |
| **Diff-wrap** toggle (`app.toggle.diffwrap`) | `app.tsx:1146-1162` |
| **Shell selection** (P4 deferral) — `configShells` + `configPreferencesUpdate`; a **global** preference (no `location`) | `docs/coverage.md` route row |
| **Custom themes from config** — `<config>/themes/*.json` (v1 documents migrated, v2 documents validated), plugin-installed themes | `theme/discovery.ts:4-21`, `theme/index.ts:18-29` |
| **Token taxonomy + dark/light/system** — nested groups (`text.feedback.*`, `background.surface.*`, `diff.*`, `syntax.*`, `categorical[]`), mode following with `pin`/`free`, runtime helpers `raise()/tint()/increase()/decrease()` | `theme/component.ts:5-48`, `theme/resolve.ts:5-53` |
| **System/terminal-derived theme** | `theme/system.ts:11-99` — the web analogue is deriving from `prefers-color-scheme`, not a terminal palette |

**Acceptance:** a theme JSON dropped in the config dir appears in the picker and
applies; dark/light/system follows the OS; the shell preference persists
through `configPreferencesUpdate`; auto-accept actually suppresses prompts.

### R13 — Forms fidelity · M

| Gap | v2 evidence |
| --- | --- |
| **Conditional fields** (`when` rules) | `routes/session/form.tsx` |
| **Review tab** — answered / missing / required annotations before submit | same |
| **External-link acknowledgement** gating | same |
| **Drafts across remount** — a half-answered form survives | `form.tsx:57-75` |

**Acceptance:** a form with a `when` rule hides/shows a field; leaving and
returning preserves answers; submitting with a required field missing is
blocked with a legible reason.

### R14 — Extension API gaps · L (contract work — needs the human)

v2's plugin API is a first-class surface; ours is narrower. Missing pieces that
block faithful extension parity:

| Gap | v2 evidence |
| --- | --- |
| **`ui.panel`** — an extension-provided **docked session panel** (split or fullscreen, with `toggleFullscreen`/`close`/`focus`), hosted at the `session.panel` slot | `component/panel-host.tsx`, `context/panel.tsx` |
| **`ui.tabs`** — extension control of session tabs (`enabled/list/open/focus/move/close`) | `plugin/api.tsx:114-249` |
| **Imperative dialogs** — `ui.dialog.show/set/clear/alert/confirm/prompt/select` | same |
| **`markdown.registerCodeBlockRenderer(language, render)`** — the fence-renderer hook (what makes mermaid/latex pluggable) | `plugin/api.tsx:130-140` |
| **`attention`** exposed to plugins | `plugin/api.tsx` |
| **`keymap.layer` + `.dispatch/.commands/.pending/.active/.mode`** — we have palette/slash contributions and manifest keybinds, not layers | same |

**Acceptance for each:** a shipped-disabled test extension can contribute the
thing and it renders; unload removes it cleanly; the battery gains checks.

**This is a contract change**: it needs a version bump + authoring-guide +
`docs/extension-system-spec.md` + `skills/webui/SKILL.md` updates in the same
commit. Do it **after** the built-in surfaces exist (R1/R2 first), so the API is
designed against real consumers rather than speculation.

---

## 5. Execution model — waves, ownership, sub-agents

### 5.1 Why waves (unchanged from the previous plan)

AGENTS rule 2 makes `src/store.ts` the single serialization point: it is one
file, one reducer, and *every* stream that adds state edits it. **Parallel
agents on overlapping files do not parallelize — they serialize on merge
conflicts.** So: freeze shared seams first, then parallelize only what touches
nothing shared.

### 5.2 Contention map (read before proposing any split)

| Stream | New files (parallel-safe) | Contended core files |
| --- | --- | --- |
| R0 defects | — | `Composer.tsx`, `SettingsDialog.tsx`, `SessionMenu.tsx`, `HelpDialog.tsx`, `api/client.ts` |
| R1 markdown | `lib/markdown/*`, `components/CodeBlock.tsx` | `MessageItem.tsx`, `ToolCard.tsx`, `Conversation.tsx` |
| R2 diagrams/math | `components/MermaidBlock.tsx`, `LatexBlock.tsx` | `MessageItem.tsx` (**shared with R1 — same agent or serial**) |
| R3 tabs/pins | `SessionTabs.tsx`, `SessionTabsRail.tsx`, `lib/sessionTabs.ts` | `App.tsx`, `Sidebar.tsx`, `store.ts` |
| R4 timeline | `TimelineDialog.tsx`, `lib/timeline.ts` | `Conversation.tsx`, `store.ts`, `Composer.tsx` |
| R5 attention | `lib/attention.ts` | `store.ts`, `prefs.ts`, `SettingsDialog.tsx` |
| R6 stats | `StatsPanel.tsx`, `lib/stats.ts` | `api/client.ts`, mount point |
| R7 diff | `DiffImagePane.tsx`, `lib/diffBranches.ts` | `DiffViewer.tsx`, `api/client.ts` |
| R8 composer | `lib/dirRecents.ts`, `DirectoryPicker.tsx`, `PermissionRejectDialog.tsx` | `Composer.tsx`, `FilePicker.tsx`, `PendingRequestsPanel.tsx`, `store.ts` |
| R9 transcript | `lib/grouping.ts`, `TurnTokens.tsx` | `MessageItem.tsx`, `Conversation.tsx`, `store.ts` |
| R10 tool cards | `ToolPatchBody.tsx`, `ToolQuestionBody.tsx`, `lib/diagnostics.ts` | `ToolCard.tsx` |
| R11 overlays | `ErrorDetailsDialog.tsx`, `ReconnectOverlay.tsx`, `UpdateNotice.tsx`, `DebugDialog.tsx`, `PairDialog.tsx`, `SessionListDialog.tsx`, `OpenPicker.tsx` | `App.tsx`, `Sidebar.tsx` |
| R12 settings/themes | `lib/themeFiles.ts`, `ShellSection.tsx` | `SettingsDialog.tsx`, `prefs.ts`, `theme/*` |
| R13 forms | `lib/formDraft.ts`, `FormReview.tsx` | `PendingRequestsPanel.tsx` |
| R14 extension API | *contract* — registry/slots/docs | `extensions/registry.tsx`, `slots.tsx`, `extensionApi.ts` |

### 5.3 Wave structure

| Wave | Who | Runs | Output |
| --- | --- | --- | --- |
| **0** | Coordinator | serial, one pass | R0 defects fixed; contract-layer additions (`VcsMode.committed`, `sessionStats`, `vcsBranches`); the store slices each stream needs; registered target ids + `data-oc-*` anchors + entry-point placeholders. One commit. |
| **1** | 3–5 sub-agents | **parallel, disjoint files** | New components/libs only, against the frozen props. |
| **2** | Coordinator | serial | Wire every entry point; resolve mismatches **in the store**, not in the unit; gates; docs (`coverage.md`, guide, spec, skill). |
| **3** | independent sub-agents | parallel | Verification per stream against the acceptance criteria in §4 — **never the implementer's own summary**. |

**Recommended first slice (do this before fanning out):** **R0 + R1 + R2
together, serially.** Markdown rendering is the highest-value, most-visible
divergence, it is one pipeline, and it establishes the pattern (a new
`components/*Block.tsx` + a coordinator-owned wire-up + a lazy chunk) that every
later stream copies. §1.3's "P2 alone first" logic applies unchanged.

### 5.4 File-ownership rules (hard)

1. A Wave 1 agent edits **only the files in its brief**. Nothing else.
2. If you need a change in a coordinator-owned file (`store.ts`, `App.tsx`,
   `Conversation.tsx`, `MessageItem.tsx`, `Composer.tsx`, `ToolCard.tsx`,
   `Sidebar.tsx`, `SettingsDialog.tsx`, `DiffViewer.tsx`,
   `PendingRequestsPanel.tsx`, `api/client.ts`, `api/types.ts`,
   `extensions/*`) — **do not edit it**. Write in your report exactly what you
   need and the coordinator applies it in Wave 2.
3. Never edit `docs/reference/openapi.json` by hand — it is generated by
   `bun run scripts/fetch-openapi.ts`.
4. Never edit the contract layer without the snapshot as justification.
5. New files only, no new dependencies (see §8.1), Tailwind + `var(--…)` tokens
   only, components-only exports, `typecheck` clean before you report.

### 5.5 Sub-agent brief template (paste this, fill the four gaps)

```
You are a Wave 1 agent in /home/zowail/opencode-webui. Read, in order:
AGENTS.md (the 10 rules), docs/tui-parity-roadmap.md, docs/parity-port-plan.md
(especially your stream and §5), then docs/coverage.md.

TASK: implement <STREAM ID + NAME> from docs/parity-port-plan.md §4.

FILES YOU OWN (create; nothing else): <list>
FILES YOU MUST NOT TOUCH: <list of contended core files for this stream>

FROZEN INTERFACE: <props/emits, copied from the plan>
V2 BEHAVIOUR TO MATCH: <the file:line evidence rows from the plan — re-open them
in /tmp/opencode/oc-v2 first and correct the plan if a line drifted>

HARD RULES
- Do NOT edit any file you do not own. Report needed shared-file changes instead.
- Do NOT run git add/commit. Do NOT run `bun run build` (the coordinator gates).
- Other agents may be writing other files in this tree concurrently: `bun run
  typecheck` may report errors in files you do not own — ignore those, report
  only errors in your own files.
- No new dependencies. Components-only exports. Tailwind utilities + var(--…)
  tokens, never hex. No component-owned setInterval (use src/lib/scheduler.ts
  if you need recurring work).

BEFORE YOU REPORT: `bun run typecheck` clean for your files. If the change is
verifiable in a browser, say what you exercised.

REPORT (exactly these five, in this order):
1. Files created (paths).
2. Interface deltas — anything the frozen contract could not express.
3. Changes needed in coordinator-owned files — file, symbol, exact change.
4. Verification — typecheck output for your files, plus what you exercised.
5. Open questions / risks.

If blocked, STOP AND REPORT. Do not widen your file ownership to get unblocked —
that is what causes the merge conflicts this plan exists to avoid.
```

### 5.6 Orchestration in practice (this harness)

- The coordinator sessions are the ones with `subagent`, `brother_agent*` and
  `browser.*`/`chrome.*` tools. Use **`subagent` with `background: true`** for
  Wave 1 fan-out (3–5 agents), then read each report.
- Use **`brother_agent`** only for a genuinely independent, long unit that
  deserves its own clean context (e.g. R3 if you split tabs off, or R14).
- Keep a **single writer per file** at all times; if two streams need
  `MessageItem.tsx`, they are one stream (R1+R2) or they are serialized.
- Wave 3 verifiers must be **fresh agents with no investment in the code**;
  give them §4's acceptance criteria and tell them to reproduce, not to trust
  the summary. A "pass" they cannot demonstrate is a fail.

---

## 6. Definition of done for the program

1. Every §4 stream is either **implemented and verified** or **explicitly
   recorded as not-ported with a reason** in `docs/coverage.md` (the
   "TUI-only mechanics" bucket is a legitimate reason — see §1's non-goals;
   silence is not).
2. Every v2 command in `config/keybind.ts` has been mapped to either a webui
   affordance or a recorded non-goal. Keep that mapping in the port plan or a
   companion table so the claim is auditable.
3. `bun run typecheck`, `bun run build`, `diff-openapi --check`, all four
   extension batteries, `check:setup` and `check:config` are green.
4. The live smoke pass (§2.4) has been done for every new mutating route, on
   throwaway sessions.
5. Docs moved with the code: `docs/coverage.md`, `webui-extensions/README.md`,
   `docs/extension-system-spec.md`, `skills/webui/SKILL.md` (and a version bump
   + `bun run scripts/gen-skill.ts` + tag for any contract change). Follow
   AGENTS.md's release checklist exactly — never publish without the tag.

---

## 7. Handoff protocol

A stream reports back with exactly:

1. **Stream id + status** (done / partial / blocked).
2. **Files created** (paths).
3. **Interface deltas** — anything the frozen contract could not express.
4. **Changes needed in coordinator-owned files** — file, symbol, exact change.
5. **Verification** — the gate output, plus what was exercised live.
6. **Not-ported items** — anything from the stream's §4 row you did not do, with
   the reason (this feeds §6.1; do not leave it implicit).
7. **Open questions / risks.**

---

## 8. Open decisions for the human (block or shape the work)

The plan is the spec; these need your call before the affected stream starts.

1. **Syntax-highlighting dependency (blocks R1; also affects R2).** AGENTS rule
   5 says a new dependency needs justification. Options:
   - **shiki** — closest to v2's fidelity, has bundled themes and grammars, maps
     cleanly onto our CSS tokens; largest, so lazy-load the chunk. *Recommended.*
   - **highlight.js** — much smaller, good enough, less faithful.
   - **prism / react-syntax-highlighter** — lightest, weakest.
   Either way it must not block first paint.
2. **Tabs vs split view (shapes R3).** v2 has a tab rail and no split panes; we
   have split panes. Recommendation: **add tabs and keep split view** — removing
   a feature v2 never had would be a regression, not parity.
3. **Notification sounds (shapes R5).** v2 ships per-event mp3s. Do we ship
   audio assets, use the WebAudio API to synthesise tones (no assets), or skip
   sounds and do notifications only? v2's `attention.enabled` defaults to
   **false**, which is a useful precedent.
4. **Where the stats surface lives (shapes R6).** v2 makes it a full-screen
   route. Ours could be a core dialog/page, or an extension `pages` entry. Core
   is the roadmap's placement rule for engine-native things.
5. **Editor handoff (shapes R8).** `/editor` opens `$EDITOR` — genuinely
   host-local. Options: skip and record as a non-goal, or implement a
   copy-to-clipboard / "open in your editor" hint. v2's editor-selection
   *context* (`prompt.editor_context`) has no web analogue at all.
6. **Mini mode.** Confirm it stays out of scope (it is a separate frontend).
7. **Pins + quick slots.** Confirm you want them now that we know they are v2
   (the old roadmap wrongly said they were not).
8. **Loop guard.** Decide when "parity" is done: my recommendation is §6 —
   every v2 command mapped, every §4 acceptance met or explicitly recorded.
   Otherwise "everything the TUI can do" has no finish line.
