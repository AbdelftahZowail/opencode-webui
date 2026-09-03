# Timestamp test — extension staleness acceptance scenario

Canonical scenario from `docs/extension-system-spec.md` §5.4: a user tweaks
only the timestamp format; the maintainer later redesigns the token counter
and adds a finish badge in the same header. **The user must get both,
visibly** — parent and siblings are still core's because the user's wrap
delegates by default. If the maintainer redesigns the timestamp itself, the
user's override still owns that one aspect: legible, tiny conflict, no fork.
`replace` is the only stale-prone path, and it is explicitly labeled as
ownership.

## Setup

1. Start an isolated instance (never the user's main webui):
   `bunx opencode-webui sandbox` (loopback-only `127.0.0.1:4099`,
   extensions from `~/.local/state/opencode-webui/sandbox-extensions/`).
2. Drop the wrap extension into the scratch dir:

```
sandbox-extensions/my-time/
  manifest.json    { "id": "my-time", "name": "My time", "version": "1.0.0" }
  index.tsx
```

```tsx
// index.tsx
import { register } from "../../src/extensions/registry"; // shipped path; external dirs use the extension API surface

register({
  kind: "wrap",
  id: "my-time-wrap",
  target: "message.timestamp",
  render: (_props, next) => <span className="tabular-nums">{next()}</span>,
});

// NOTE: one entry per id — same-id re-register SWAPS. The service needs its
// own id or it evicts the wrap above.
register({
  kind: "service",
  id: "my-time-format",
  service: "format.timestamp",
  value: (ms: number) => new Date(ms).toLocaleTimeString(),
  precedence: 10,
});
```

3. Confirm it loads with no rebuild/refresh/restart: the manifest push
   (`GET /api/webui/extensions/events`) fires, the page same-id-swaps, and
   message timestamps render through the wrap (tabular numerals, custom
   format). Record a screenshot / DOM sample of a message header as baseline.

## The maintainer update (simulated)

4. In core, redesign the message header's *siblings* without touching the
   timestamp: change the token counter markup and add a finish badge next to
   it (same header, same `message.timestamp` target id and props).
5. Hot reload applies; the extension folder is untouched.

## Expected result (PASS criteria)

- [ ] The custom timestamp format is still applied (wrap + service intact).
- [ ] The redesigned token counter and the new finish badge are visible
      (parent and siblings are still core's — the wrap delegated).
- [ ] No console errors from the extension; no full-page reload occurred.

## Ownership contrast (replace)

6. Swap the wrap for a `replace` on `message.timestamp` rendering a custom clock.
   Repeat the maintainer update.
7. Expected: the custom clock still owns the timestamp (core's redesign of
   that one unit does NOT show) — legible, tiny conflict — while the token
   counter + finish badge still update. This is frozen-snapshot semantics:
   correct behavior for `replace`, and why `wrap` is the default path.

## Wrong-stratum contrast (dom.ts)

8. Implement the same tweak as `dom.ts` restyling the timestamp node.
   Repeat the maintainer update.
9. Expected: fragile — a markup/anchor change silently breaks the tweak.
   Documents why DOM is the marked last resort (portals, canvas, iframes —
   not registered units).

## Regression guards (run every time)

```
# Deletion completeness (§10 — clean since the core-migration step landed):
grep -rn "<Slot" src webui-extensions 2>/dev/null
grep -rn "webui-extensions/config" src webui-extensions server scripts 2>/dev/null
grep -rn "kind: *\"region\"\|kind: *\"message\"\|kind: *\"tool.renderer\"\|message\.decoration\|message\.part\|tool\.renderer" src webui-extensions 2>/dev/null | grep -v "no legacy kinds"
bun run typecheck   # must stay green
```

Note (2026-09-02): the legacy adapter + `<Slot>` + `config.ts` were deleted
by the core-migration step (§11.4) — these greps are clean; `typecheck`
stays green throughout.
