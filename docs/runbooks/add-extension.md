# Runbook — when you touch the extension system

**Trigger:** adding/changing a registry kind, target, slot, collection, service,
hook event string, manifest field, `data-oc-*` anchor, or the extension API
surface. Read `reference/extension-system-spec.md` first — it is the contract.
`plans/extensions.md` is the *why/next*; the authoring guide
(`webui-extensions/README.md`) is what authors read.

The rule that makes this a runbook: **the extension contract is enforced by
discipline today, and it has drifted** (E7 in `plans/extensions.md` is the fix).
Until E7 lands, the discipline is manual — so do it every time.

## Contract rules

- **Ids are contract:** target ids, collection ids, service ids, `data-oc-*`
  anchors, manifest fields, and the bridge surface (`src/lib/extensionApi.ts`,
  `EXT_API_VERSION`). **Renaming or moving any of them = a version bump + a
  migration note in the same commit.** Never break silently.
- **Widen an axis; don't add a kind.** A new seam is usually a new *hook event
  string* (open) or a new *collection* (data). A new **kind** is a deliberate
  contract change: registry + docs + version bump together.
- **One method per concern.** No second registry, gate, loader, fallback, or
  action surface.
- **Stale-proof by default.** Prefer flow-through wraps and consulted services
  over frozen snapshots. `replace` is the marked escape hatch (ownership).
- **Crash-isolated + hot-swap-safe.** A broken extension must never break the
  core path; edits swap in place with no ghosts.
- **Never absorb an extension into core.** Optional features ship as shipped
  extensions; core stays minimal. We dogfood the public API or it rots.

## Steps

1. **Decide the stratum.** React-tree change → wrap/replace/contribute/hook/
   service. Across an arbitrary DOM boundary → `dom.ts`. Always-on / fs / spawn /
   engine creds → `server.ts`. Tools the model calls → `engine/`.
2. **Prefer the smallest widening.** New event name > new collection > new
   target > new kind.
3. **Ship with the docs, in ONE commit:**
   - `reference/extension-system-spec.md` (the contract),
   - `webui-extensions/README.md` (the authoring guide),
   - `plans/extensions.md` (mark the seam landed),
   - `skills/webui/SKILL.md` — regenerate via `bun run scripts/gen-skill.ts`
     **after** bumping `package.json` version (the skill pins `v{version}` raw
     links, so it must be regenerated in the release commit, and the tag must be
     pushed for the links to resolve).
4. **Version bump.** `package.json` `version` is the ONE source. A contract
   change is at least a **minor** bump; a breaking id change is **major**.
5. **Add battery checks** for the new seam. The extension batteries are the
   release gate:
   ```
   bun run scripts/uitest/ext-battery-browser.ts   # 34
   bun run scripts/uitest/ext-battery-dom.ts       # 10
   bun run scripts/uitest/ext-battery-proxy.ts     # 17
   bun run scripts/uitest/ext-battery-acceptance.ts # 15
   ```
   Run them **sequentially and with no other agent active** (a concurrent
   subagent floods `/api/event` and evicts the proxy tap ring → test 8 flakes).
6. **Prove the seam with a real probe**, not just a unit: build one small
   extension through the public bridge alone and note the friction. That friction
   is the next roadmap item.

## Hot-reload guarantees (must hold after your change)

- External browser bundles rebuild on edit, bump `?v=` (folder-wide fingerprint,
  not just the entry file), push the manifest over the single `/api/event`
  stream, and same-id-swap with a live repaint — sub-second, no refresh.
- Proxy `server.ts` modules reload with no proxy restart.
- Repo dev uses Vite HMR.
- Disable/delete/hot-swap must tear down cleanly (no manual `window.__*` guards).

## Authoring guide

`webui-extensions/README.md` is the one guide; load `skills/webui/SKILL.md` for
the agent-facing version. If they disagree with the spec, the spec wins and the
others get fixed in the same commit.
