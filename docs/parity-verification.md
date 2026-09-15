# Parity verification — independent review (Wave 3)

**Verifier:** independent agent (wrote none of the code under review).
**Date:** 2026-09-15.
**Commits reviewed:** `2e757c5` (Wave 0 seam), `29580d5` (P2 diff viewer),
`0f6408f` (Wave 1 units + Wave 2 wiring), `31cd74a` (P7 debts + client migration).
**Acceptance criteria source:** `docs/tui-parity-roadmap.md` (phase bodies) and
`docs/parity-execution-plan.md` §5 unit briefs.

> Method: every claim below was re-derived from the **live engine**
> (`Service.ensure()`, direct `/api/*`), from **git** (`git diff`, read-only), or
> from the **running :4097 install**. No implementer summary was trusted. The
> only file created is this one; no source file was modified.

---

## 0. Gates (re-run independently)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | **PASS** (`tsc --noEmit`, exit 0) |
| Build | `bun run build` | **PASS** (`vite build`, 2256 modules, exit 0) |
| Contract drift | `bun run scripts/diff-openapi.ts --check` | **PASS** (snapshot 123 paths/241 schemas = live; exit 0) |
| Extension battery | `bun run scripts/uitest/ext-battery-browser.ts` | **PASS** 34 pass / 0 fail |
| Extension battery | `bun run scripts/uitest/ext-battery-dom.ts` | **PASS** 10 pass / 0 fail |
| Extension battery | `bun run scripts/uitest/ext-battery-proxy.ts` | **PASS** 17 pass / 0 fail |
| Extension battery | `bun run scripts/uitest/ext-battery-acceptance.ts` | **PASS** 15 pass / 0 fail |

The acceptance battery's `gen:skill` step rewrote `skills/webui/SKILL.md`
byte-identically (`git status` clean afterwards). `git status` at report time
shows one untracked, **unrelated** file that appeared during verification
(`docs/extension-roadmap-2.md`, mtime 15:52, not created by this review — it
belongs to concurrent work in the repo).

---

## P2 — Turn-scoped diff viewer — **PASS**

### P2.1 "A completed turn's diff matches `git diff` for the same range" — PASS (exact)

The engine's turn diff for `ses_f5b0ebd33ffenAYF4cs7sLmxLC` ("Parity execution
plan review", directory `/home/zowail/opencode-webui`) was fetched and compared
mechanically to git:

```
GET /api/session/ses_f5b0ebd33ffenAYF4cs7sLmxLC/diff?context=12   → 200, 54 files
git diff --numstat 78c170f..31cd74a | LC_ALL=C sort                → 54 lines
diff <engine numstat> <git numstat>                                → IDENTICAL SET
```

- All **54** files match, and every file's `additions`/`deletions` match exactly
  (`AGENTS.md 1/1`, `package.json 2/2`, `src/store.ts 433/2`,
  `src/components/DiffViewer.tsx 507/0`, `PermissionRulesEditor.tsx 325/0`, …).
- Patch **text** is byte-identical too: for `src/lib/scheduler.ts`,
  `git diff -U12 78c170f..31cd74a -- src/lib/scheduler.ts` equals the engine's
  returned patch verbatim (same `diff --git`/`index` header and hunks).

The client stores only `context` and passes **no** `from`/`to`
(`src/store.ts:3163`), i.e. it uses the engine default (newest user-message
turn). The turn traced to git range `78c170f..31cd74a` — four commits produced
inside a single user turn.

### P2.2 "A steered-prompt turn appears as one turn" — PASS (live steer)

An initial attempt was a **false steer** (the first tiny turn had already gone
idle before the second prompt, so the second was a normal turn and the diff was
split). With the session *provably busy* at steer time the claim holds:

```
P1: "create one.txt; then run shell `sleep 30`; reply DONE"   → admitted
(after 8s: one.txt exists=true, two.txt=false ⇒ mid-turn, BUSY)
P2 (delivery:"steer"): "create two.txt; reply DONE2"          → admitted
GET .../message?type=user                                     → 2 user messages
GET .../diff?context=12  (no from/to)                          → added:one.txt, added:two.txt
```

Both files created across the steered prompt appear in the **single** default
turn diff. (Note for the record: the "idle marker to idle marker" wording is
accurate for a genuine steer; `from=<steer msg>` alone also returned both files,
confirming the steer message lives inside the same idle-bounded turn.)

### P2.3 "No renderer duplication" — PASS

`parseDiff` is defined exactly once in the tree:

```
grep -rn "function parseDiff" src/  → src/components/DiffView.tsx:27   (only hit)
```

The viewer reuses it: `src/components/DiffViewer.tsx:28` imports `DiffView`
(rendered at `:420`); `src/lib/sessionDiff.ts:10` imports `parseDiff`/`groupHunks`
for hunk counts. `DiffView` is also reused by `FileExplorer.tsx:36/507` and
`ToolCard.tsx:15/540`. `DiffView.tsx:155` memoises `parseDiff`. The only other
`split("\n")` in `src/api/` is the SSE-log cursor parser (`client.ts:615`),
unrelated to diffs. No second parser/renderer exists.

Tree, per-file (n/p) + per-hunk (j/k) nav, split/unified, review markers, three
sources are all present (`DiffViewer.tsx`), with the source switcher wired to
`store.setDiffSource` → `api.sessionDiff` / `api.vcsDiff`.
Live checks: `GET /api/vcs/diff?mode=working|branch`, `GET /api/vcs/base` → 200.

Verdict: **PASS** on all three acceptance clauses.

---

## P3 — Worktrees + workspaces — **PASS**

Live-tested against a throwaway git repo `/tmp/opencode/verify-scratch`
(12/12 checks). The engine wrote the worktree under
`~/.local/share/opencode/worktree/687145/verify-wt`; it was removed with
`force:true`.

| Check | Observed |
| --- | --- |
| `GET /api/worktree?location[directory]=…` | 200, body `[{"directory":"/tmp/opencode/verify-scratch"}]` — **bare array** |
| `POST /api/worktree?location…` `{name:"verify-wt"}` | 200, bare object `{"directory":"…/687145/verify-wt"}` |
| list after create | 2 entries (worktree + source) |
| `POST /api/worktree/refresh` | **204**; list reconciled 2 → 2 |
| `DELETE … {directory, force:true}` | **204**; list back to baseline (1) |
| residue | `git worktree list` → only source; `.git/worktrees` empty; worktree parent dir empty |

**Client-wrapper fix is correct.** `Worktree.List` in the OpenAPI snapshot is a
bare `array` and `Worktree.Info` a bare `object`; `request<T>` returns the raw
parsed JSON (no `{data}` unwrap, `src/api/client.ts:145-159`), so
`worktreeList: request<WorktreeDirectory[]>` (`client.ts:890`) and
`worktreeCreate: request<WorktreeInfo>` (`:892`) are right. The store also guards
non-arrays (`src/store.ts:3276-3278`). The old `{data}` assumption would have
crashed the panel; the fix matches the schema.

Verdict: **PASS**.

---

## P4 — Actionable settings — **PASS**

### Plugins

- `GET /api/plugin` → **200**, 88 plugins (`builtin` 84, `local` 4), **2 failed**
  (`~/.config/opencode/plugins/gsd-core.js`, `…/webui-extensions/rich-render/engine`).
- `docs/reference/openapi.json` plugin surface: `GET /api/plugin`,
  `POST /api/plugin/check`, `POST /api/plugin/update`,
  `POST /api/plugin/await-activation`. **There is no enable/disable route** — the
  "no toggle" claim is **confirmed**.
- `PluginsSection.tsx` renders all four `PluginSource` kinds
  (`builtin`/`package`/`local`/`sdk`, `SourceDetail` switch) and the failed state
  (`state.status === "failed"` + `state.error` + `state.ref`), with `Check` /
  `Update` / `Update all` actions and no config dump. Wired via
  `SettingsDialog.tsx:160-162,354-369` → `store.checkPlugins/updatePlugins`
  (`store.ts:3353-3384`). Acts, not displays. **PASS.**

### Permission rules — live round-trip PASS

Throwaway session created → `PUT /api/session/{id}/permission/rules`:
- PUT → **204**.
- `GET /api/session/{id}` returned the exact 3-rule array **in order**
  (allow/deny/ask), i.e. it round-trips.
- A second PUT replaced (did **not** merge) the ruleset.
- The throwaway session was deleted (204; re-GET 404).
- Save is a **single** PUT: `store.updateSessionPermissionRules`
  (`store.ts:3392-3398`) issues one `api.sessionPermissionRules` then a session
  re-read.
- Editor supports add/remove/reorder + all three effects
  (`PermissionRulesEditor.tsx:110-135,219-273`), wired from
  `SessionMenu.tsx:93-97`.

### MCP add/remove — live PASS

On scratch location: `GET /api/mcp` → `[]`; `PUT /api/mcp/{name}` → **204**;
re-list → 1; `DELETE` → **204**; re-list → 0. No file residue in the scratch dir
or the user config. UI path: `McpIndicator.tsx` → `lib/mcpStatus.putMcpServer/
deleteMcpServer`.

### Credentials relabel — live PASS; delete code-verified

Live relabel round-trip on the real credential `cred_037d…`: `default` →
`verify-tmp-label` → `default` (both 204, confirmed via `GET /api/integration`).
Delete was **not** executed (destructive against a real credential); the route
exists and the callers are `IntegrationsSection.tsx:481-571` (`CredentialActions`
→ `api.credentialPatch` / `api.credentialDelete`).

Verdict: **PASS**, with the "package/sdk source kinds" and "credential delete"
exercised at code level only (see discrepancies).

---

## P6 — Client-side conveniences (stash/frecency) — **PASS**

Purity, cap and persistence were tested by a standalone bun script in
`/tmp/opencode` (not in the repo) with a stubbed `localStorage`: **21 pass / 0 fail**.

- `MAX_STASH_ENTRIES === 50`; 55 pushes → exactly 50, oldest (`prompt 5`) dropped,
  newest (`prompt 54`) kept.
- Persistence round-trip: key written, `listStash()` reads back identical; pop
  removes newest; remove-by-index works; empty push is a no-op.
- Frecency maths: `frequency/(1+ageDays)`, missing → 0, `rankByFrecency` puts
  scored first / unknown last (stable), `recordUsage` is pure and caps,
  `pruneFrecency` keeps the 1000 newest.
- **Purity:** `src/lib/frecency.ts` and `src/lib/stash.ts` contain **zero
  imports** (`grep -n "^import"` → none); neither references `store.ts` or React
  (only comment text mentions them). Storage lives in `frecencyStore.ts` /
  `stash.ts` localStorage, not the pure maths.

UI: `StashPanel.tsx` presentational; `Composer.tsx` wires it
(`:457,470,1299,1462`) with Ctrl+S stash + pop. `FilePicker.tsx:6-7,60,88`
consumes `rankByFrecency`/`loadFrecency`/`recordFileUsage`.

Verdict: **PASS**.

---

## P7 — Webui correctness debts — **PASS** (doc-status stale; see discrepancies)

| Item | Evidence | Verdict |
| --- | --- | --- |
| (a) `store.interrupt` uses `{interrupted}` | `store.ts:4401-4429` reads `res.interrupted`; `false` returns without fabricating a stop; failure pushes a run notice. Live: idle `POST /api/session/{id}/interrupt` → **200 `{"interrupted":false}`** | PASS |
| (b) `contextMenu.file` real consumer + registry type | `FileExplorer.tsx:85-87,152-171` renders `getContributions("contextMenu.file")` (`:248-251`) with a built-in "Copy path"; `ContextMenuContribution.run` ctx includes `file?: string` (`registry.tsx:165-172`); documented in `extension-system-spec.md:101` + `webui-extensions/README.md:369` | PASS |
| (c) dependency migration | `package.json:49` `"@opencode/client": "2.0.3"`; **no** `@opencode-ai/client` in `package.json`; `bun.lock` has zero `@opencode-ai`; all `Service` imports use `@opencode/client/service` | PASS |
| (d) `diff-openapi.ts --check` exits 0 | exit 0, no drift | PASS |

---

## Pre-existing hooks crash — confirmed NOT attributable to this work

On the **untouched production install `:4097`**, after loading the root the
browser console shows (via the connected Chrome session):

```
[error] [extensions] wrap "brother-agent-row" crashed, falling through:
        Error: Minified React error #310 … [19 times]
[error] [extensions] wrap "brother-agent-header" crashed, falling through:
        Error: Minified React error #310 …
```

React error #310 is *"Rendered more hooks than during the previous render."*
The crashing code is the **external user extension**
`~/.config/opencode/webui-extensions/brother-agent/index.tsx:123-164`, which
calls `useBrotherVersion()` inside its `wrap` render callbacks; its files are
dated **Sep 3** and it is not part of any parity commit. `:4097` serves the same
user extension (`GET :4097/api/webui/extensions` lists it), so the error is
present with **no** parity code in the picture. Reproduced; **pre-existing**.

---

## Discrepancies, overstated/unproven claims

1. **Roadmap Status table is stale.** `docs/tui-parity-roadmap.md:94` still
   labels P7 "in progress", but all four P7 body items are ✅ and `31cd74a`
   landed them. The P7 commit did touch the roadmap (+30/−…) but left the status
   cell saying "in progress". Minor doc inconsistency.
2. **Stale `@opencode-ai/client` left on disk.** After the `2.0.3` migration,
   `node_modules/@opencode-ai/{client,protocol,schema}@0.0.0-next-17444` still
   exist physically (not in `package.json`/`bun.lock`; no source imports it).
   Also `scripts/uitest/setup-check.ts:88,107` still names
   `@opencode-ai/client` as a mirror fixture (a synthetic path, so the check
   still passes, but the name is stale). Cosmetic, not a runtime defect.
3. **"`location` on every `/api/mcp/*`" is only half true.** The client wrappers
   all *accept* `location`, but the actual callers pass none:
   `lib/mcpStatus.ts:49` (`api.mcpList()`), `:99` (`api.mcpPut(server, config)`),
   `:105` (`api.mcpDelete(server)`). Mutations are therefore global-scoped, not
   project-scoped. It works (verified `GET /api/mcp` with and without location),
   and the indicator's list is global anyway, but the execution-plan wording
   overstates it. Same for `credentialPatch/Delete` (`client.ts:1175-1180`),
   which never pass the route's optional `location`.
4. **PluginsSection per-target "busy detail" branch is dead.**
   `PluginsSection.tsx:94-96` reads `detail === target` from a
   `"check:<target>"` suffix, and the header comment says the store suffixes the
   target — but `store.checkPlugins` always sets `pluginsBusy: "check"`
   (`store.ts:3355`). The row spinner still works via the component-local
   `pending` state; the `busyDetail` path is unreachable. Cosmetic.
5. **"Renders all four source kinds" is code-verified, not live-verified.** The
   live catalog contains only `builtin` (84) and `local` (4) — no `package` or
   `sdk` plugin exists on this engine, so those two render paths are only
   inspected in source, and the "update available" affordance is never
   exercised live.
6. **`permissionSavedList`/`permissionSavedDelete` are wrapped but unused.**
   `store.listSavedPermissions`/`deleteSavedPermission` (`store.ts:3401-3410`)
   have no consumer anywhere outside `store.ts` (grep). The roadmap says "also
   *consider* wrapping", so this is acceptable, but it is dead code today.
7. **Browser-console verification of the new UI was not possible.** The desktop
   `browser.*` tools are disconnected in this session, so the diff viewer /
   stash panel / settings were verified via source + live API calls, not by
   clicking the rendered pixels. The one browser check that *was* possible (the
   `chrome.*` page) was used only to reproduce the pre-existing hooks crash.

### New bugs found

None that break an acceptance criterion. The items above are doc staleness,
unreachable branches, and unused wrappers — not regressions. No new runtime bug
was reproduced.

---

## Verdict summary

| Phase | Verdict | Key evidence |
| --- | --- | --- |
| P2 diff viewer | **PASS** | engine turn diff ≡ `git diff 78c170f..31cd74a` (54 files, exact counts + byte-identical patch); genuine steer → one turn; `parseDiff` defined once |
| P3 worktrees | **PASS** | bare-array list; create/list/refresh(204)/remove(force, 204); zero residue; wrapper matches schema |
| P4 settings | **PASS** | plugins list + no toggle route; permission rules PUT 204/round-trip/replace; MCP add+remove; credential relabel round-trip |
| P6 stash/frecency | **PASS** | 21/21 standalone; 50-cap; persistence; pure libs import nothing |
| P7 debts | **PASS** | interrupt `{interrupted:false}` live; `contextMenu.file` consumer; `@opencode/client@2.0.3`; drift check exit 0 |
| Gates | **PASS** | typecheck, build, drift, 4 batteries all green |
| Pre-existing hooks crash | **confirmed pre-existing** | React #310 on untouched `:4097`, from the external Sep-3 `brother-agent` extension |

---

## Coordinator addendum (post-verification)

Written by the implementing agent after acting on the findings above. Source
changes made in response: none of the PASS verdicts were affected.

- **Finding 5 (unreachable per-row busy branch) — fixed.** `store.checkPlugins`
  now sets `check:<target>` for a targeted check, and `updatePlugins` sets
  `update:<target>` for a single target (`"update"` for a batch, so the header
  spinner still owns the batch case). Both the engine-driven row spinner and
  the local `pending` fallback are now live paths.
- **Finding 6 (unused `permissionSavedList`/`Delete`) — fixed by wiring.** The
  SessionMenu permission dialog now lists the project's saved ("always allow")
  rules with per-row removal, which is also where a user would expect the
  `always` replies to be undone. Not dead code any more.
- **Finding 7 (no browser-pixel verification) — partially closed** by the
  coordinator, who has the Chrome MCP page. Clicking the rendered UI confirmed:
  - diff viewer: three sources, 17→54 changed files with A/M/D marks, hunk
    counter, unified/split toggle, "Mark reviewed", collapse/expand-all;
  - Settings → Plugins: live engine plugin list (builtin `opencode.*` entries
    with features + `active`), "Check for updates";
  - session menu → Permission rules…: editor opens with the "last matching
    rule wins" copy and the empty state "No session rules — the agent's own
    rules apply";
  - stash: Ctrl+S stashed a prompt (chip → "stash 1"), the panel replaced the
    composer, Enter restored the text and emptied the stash;
  - Worktrees: the picker listed the real directory from `/api/worktree`, with
    Use/Remove/Refresh/Create and the setup-script warning;
  - FileExplorer: right-clicking a file row opens "Copy path" (the new
    `contextMenu.file` consumer); left-click still opens the preview.
  The settings-tab stale copy in the docs was corrected.
- **Finding 1 (stale P7 status cell) — fixed**; the roadmap row now reads done.
- **Finding 2 (stale `@opencode-ai` dirs / fixture) — fixed for the fixture**:
  `scripts/uitest/setup-check.ts` now mirrors `@opencode/client` (the test
  fabricates its own temp install, so it never actually depended on the real
  name). `check:setup` re-ran green (50/50). The leftover
  `node_modules/@opencode-ai/*` directories are bun's garbage, un-referenced by
  `package.json`/`bun.lock`; removing them is cosmetic and was left alone.
- **Findings 3 and 4 — corrected in the docs rather than the code:** the MCP
  row no longer claims every *call* passes `location` (the wrappers accept it;
  the indicator intentionally uses the ambient scope), and the plugin row now
  states that `package`/`sdk` and "update available" are code-verified only,
  because the live catalog contains just `builtin` and `local`.
- **The steered-prompt check deserves credit:** the verifier's first attempt
  was a false steer (the session was already idle) and it caught that, then
  forced a genuinely busy session and re-ran. That is the difference between a
  plausible test and a real one.

One unrelated untracked file exists in the tree —
`docs/extension-roadmap-2.md` (mtime 15:52) — a proposal about the extension
system that is not part of this work and was deliberately left untouched.
