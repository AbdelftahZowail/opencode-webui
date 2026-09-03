# Extension friction fixes — reported + inferred

Status: **landed — all rows done except the two recorded decisions below.**
Worked top to bottom in four parallel slices (docs / server / browser /
test-tooling); each row independently committable. DSH-mapping row dropped
by decision (core docs stay platform-agnostic).

Source logs: groq-voice port report, rich-render port report (§F/C/A/T),
brother-agent friction log (F1–F9, C1–C3, A1–A3, T1–T4). Rank = reporter's
pain rank. "Valid?" is the integrator's verdict.

## Already fixed (v2.0.0 + follow-ups, do not redo)

| Id | Friction | Fix |
|---|---|---|
| B-F1–F7, R-A4 | Engine seam undocumented (export shape, `tools.` prefix, `{output}` results, `{type:"text"}` hints, metadata-via-REST, discovery/auth split, log paths) | `webui-extensions/README.md` engine section |
| B-F8, G-F1 | Target ids undiscoverable | README target-inventory table + persisted-vs-live guarantee |
| G-F2, R-A1 | One-entry-per-id silent eviction | README hygiene rule + `register()` swap warning |
| R-F4 | `src/` runtime imports break external copies | README bridge-only rule + `Bun.build` log output printed loudly |
| B-F9 | `SessionInfo` lacked `metadata` | Field added, openapi-aligned |
| Sandbox stacking | Second `bun run sandbox` collided | Auto-isolate in `scripts/sandbox.ts` + guide/skill docs |

## Queued — reported frictions

### Docs / catalogs

- [x] **Loading-lifecycle section (R-F3, med).** One guide section tracing
      glob `export const id` → manifest/SSE → proxy bundling, with file
      pointers. Valid: yes, three-file scavenger hunt is real.
- [x] ~~DSH slot → v2 mapping table~~ — DROPPED by decision: core docs
      stay platform-agnostic. Per-source migration detail is the migrator's
      job, not the core's; we don't maintain mappings to every platform on
      earth.
- [x] **`@/` alias + `import type` safety line (G-F6, A2-rich, med).** One
      README line each. Valid: yes, trivial.
- [x] **User-facing pause guidance (R-A3, low).** Where a settings-toggle
      belongs vs manifest `disabled`. One sentence. Valid: borderline, but
      cheap.
- [x] **Verified minimal engine-plugin example (R-A4 remainder, med).**
      `docs/engine-payload-convention.md` gains a fixture proven against a
      probe engine (pairs with IN-5). Valid: yes.

### Kits / core additions

- [x] **`ctx.engine` credential helper (B-C1, HIGH).** `server.ts` authors
      hand-parse `service.json` today. Add a documented fetch helper on the
      server context (`server/ext/types.ts`). Valid: yes — third occurrence
      of hand-rolled discovery makes it kit by our own rule.
- [x] **Importable server types (B-C2, med).** External dirs can't import
      core; authors duplicate `ServerExtensionModule` shapes. Expose a
      type-only surface or bless the structural-type pattern in the guide.
      Valid: yes.
- [x] **`message.markdown` leaf target (R-C1/F1, med).** Would enable a
      React-side alternative to DOM injection. Additive, safe. Valid: yes,
      but weigh against "DOM is the marked last resort" framing first.
- [x] **Settings-UI prefab/snippet (R-C4, low).** Canonical checkbox markup
      in the guide. Valid: yes, cheap.
- [x] **`kit.foreign` position param + `onRemove` signal (R-C2/C3, low).**
      Valid: yes, small.
- [x] **Folder-level id tracking (G-F2/F4 remainder, med).** Alternative to
      the one-id doc rule: loaders snapshot the registry around bundle import
      and record the id delta, so disable/delete unregisters exactly what the
      folder added. Bigger; decide rule-vs-tracking explicitly. (Pairs with
      IN-3.)

### Test loop

- [x] **Shared DOM harness (R-T1, HIGH).** Generalize the rich-render CDP
      harness to `scripts/uitest/dom-harness.ts` (fixture page + evaluate
      helper). Valid: yes — biggest time cost in that port.
- [x] **`check:ext <dir>` pre-flight command (B-T1/T2 related, HIGH).**
      Manifest + entry + engine-shape + bridge-only-import lint, no browser.
      F4-class failures in seconds instead of model round-trips. (Pairs with
      IN-5.)
- [x] **Per-agent worktrees for parallel extension work (R-T3, HIGH).**
      Process rule, not code: parallel authors get isolated checkouts, never
      share a live extension dir. Valid: operator-caused, but the rule should
      be written down (here).
- [x] **Proxy crash-reason persistence (G-T8, med).** Cause unknown on one
      sandbox death. Valid: yes, small.

## Queued — inferred structural fixes

These generalize the reports: rules/architecture that preempt frictions
nobody has hit yet.

- [x] **IN-1 — Loud boundaries.** Standing rule: every seam validates at
      entry and logs with extension id + remedy. Remaining gap: a dev-mode
      error channel (one endpoint for recent discovery/bundle/hook failures,
      one page badge). Generalizes: swap warning, build logs, engine drain.
- [x] **IN-2 — Generated catalogs.** Target/hook/collection tables generated
      from code at `gen:skill` time and asserted by the battery (the anchor
      guard is the template). Stale docs become failing tests. Generalizes:
      F8, G-F1, R-F2.
- [x] **IN-3 — Loader id-delta tracking.** See folder-level tracking above.
      Generalizes: one-id rule, settings-dialog leak.
- [x] **IN-4 — Second occurrence becomes kit.** Standing rule (domKit is the
      precedent): anything two extensions hand-roll becomes kit. Current
      backlog: `ctx.engine`, server types, DOM harness, settings snippet.
- [x] **IN-5 — Engine seam proof.** Verified fixture + probe-engine battery
      step + `check:ext` static lint. Generalizes: F1–F4, T1–T2.

## Queued — reported frictions (brother-agent completion round)

- [x] **Engine-target override (HIGH).** `Service.ensure()` reads only the
      default XDG state file; no way to aim a proxy at a chosen engine (a
      hand-written `service.json` with a stale pid spawned a rogue serve).
      Fix: honor `WEBUI_ENGINE_URL` + `WEBUI_ENGINE_PASSWORD` in
      `server/index.ts` `serviceEndpoint()`; document in the skill env table.
- [x] **Headless proxy-only sandbox (HIGH).** `scripts/sandbox.ts` always
      boots Vite. Fix: `WEBUI_SANDBOX_NOVITE=1` / `--no-vite`.
- [x] **Pin probed-working models in acceptance (HIGH).** Config-default
      model ids rot between betas (`ModelUnavailableError`, silent session
      death). Fix: acceptance notes require a probed model (`POST
      /session/{id}/generate {"prompt":"OK"}` first).
- [x] **`WEBUI_EXTENSION_DIR` doc correction (MED).** Skill says "replace";
      it is a higher-precedence add (the `shadowed` log is the only signal).
      One-line fix in the guide sandbox section.
- [x] **Probe-engine recipe (MED).** Plain `serve` + cwd + hand-written
      `service.json` with live pid; `/api/plugin` populates lazily (poll
      after boot). Into `docs/engine-payload-convention.md`.
- [x] **Origin-filter spec decision (MED).** Subagent grandchildren inherit
      `metadata.origin=brother-agent`, so `list` includes delegated
      descendants. Decide document-vs-strictly-filter in
      `engine/definitions.cjs` `toolList`.
- [x] **E2E prompts use the execute path (MED).** First direct `watch` call
      flaked as "Unknown tool"; retry via execute path worked. Runbook note.

## Process (standing)

- Extension work happens in isolated sandboxes AND isolated checkouts
  (IN-3 worktree rule above); one sandbox per extension; never two writers
  to one ext dir.
- Every contract-relevant change updates guide + skill + battery in the same
  commit (AGENTS.md rule 9). This doc moves rows to "Already fixed" with the
  hash as they land.
