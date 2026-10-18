# Docs — what lives here and how to read it

This tree is organized by **kind of document**, not by feature. Five buckets:

| Bucket | Question it answers | Files |
| --- | --- | --- |
| **Principles** | *What we do* (and don't) | `principles.md` |
| **Plans** | *What* to build next, and the state of what's built | `plans/parity.md`, `plans/extensions.md` |
| **Runbooks** | Checklists for *when X happens* | `runbooks/*.md` |
| **Reference** | The facts: contract, route map, behaviour, deployment | `reference/*`, `operations.md` |
| **When** | Conditional TODOs — "when X happens, do Y" | `when.md` |

`AGENTS.md` (repo root) is the law and the router — architecture, the rules you
must not break, and a "where to look" table. Everything here is subordinate to
it. `skills/webui/SKILL.md` and `skills/testkit/SKILL.md` are generated from
`scripts/gen-skill.ts` and installed to `~/.config/opencode/skills/` on boot.

## Read order for a fresh agent

1. `AGENTS.md` — architecture + the rules + the router. Non-negotiable.
2. `principles.md` — what we build and what we don't.
3. `reference/coverage.md` — the per-route have/don't-have/why API map.
4. `plans/parity.md` — the goal, the state, and the remaining work.
5. `plans/extensions.md` — the extension-system seams (landed + next).
6. Your brief (the relevant section of a plan + the runbook for your kind of change).

## Index

| File | What it is |
| --- | --- |
| `principles.md` | What we do / don't: port the TUI, features-not-endpoints, purpose, record every skip, non-goals. |
| `plans/parity.md` | **The hand-off plan.** Goal, ground truth, what landed (P0–P7), what remains (R0–R14), the wave/ownership execution model, definition of done, open decisions. |
| `plans/extensions.md` | The extension-system seams: landed (items 1–9), next (E1–E7), and the as-demand bucket. Subordinate to `reference/extension-system-spec.md`. |
| `runbooks/engine-update.md` | **When the engine/API changes.** Diagnose → regenerate → resync → re-verify → rewrite coverage. |
| `runbooks/add-extension.md` | **When you touch the extension system.** Contract ids, version bump, docs/skill/battery sweep in one commit. |
| `runbooks/add-ui-surface.md` | **When you add a core component.** Self-register, `<Target>` call site, anchors, slots, tokens, store-only-state. |
| `runbooks/agent-testing.md` | **When you test a plugin/extension end-to-end.** Boot an isolated instance, drive the real webui + TUI, assert rendered evidence. |
| `reference/coverage.md` | The route map: have / client-only (with reason) / genuine gap / experimental. |
| `reference/extension-system-spec.md` | The extension-system contract (strata, kinds, precedence, deletions, acceptance). |
| `reference/engine-payload-convention.md` | The `engine/` stratum convention + the verified minimal fixture + the agent-testing runbook. |
| `reference/frontend.md` | How the chat UI works: streaming/robustness, rendering, tool cards, keys, debug logging. |
| `reference/setup.md` | First-run setup: the global command + the three managed engine plugins. |
| `reference/telemetry.md` | Anonymous usage telemetry: privacy posture, wire contract, gating, the hub dependency. |
| `reference/notices.md` | Product notices: the hub announcement + version feeds, the transient card + the permanent Settings › About home, fail-open, dismissal. |
| `reference/openapi.json` | Generated OpenAPI snapshot. **Path is hard-coded in `scripts/*-openapi.ts` — do not move.** |
| `operations.md` | Deployment: reverse proxy (Caddy/nginx), env vars, auth/exposure, serve/security config. |
| `when.md` | Conditional TODOs: trigger → task. |

## Not in this tree

- **Release runbook** — `.opencode/release-helper.md` (kept at that exact path
  because the super-vibe ship skill reads it; it is the live, per-release record).
- **Contributing** — `CONTRIBUTING.md` (repo root; the human-facing entry point).
- **Authoring guide** — `webui-extensions/README.md` (ships with the extensions).
- **The law/router** — `AGENTS.md`.
