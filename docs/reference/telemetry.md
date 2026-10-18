# Anonymous usage telemetry

`server/telemetry.ts` sends one small heartbeat from the **proxy** (never the
browser) to the shared telemetry hub. It mirrors the Quickly implementation's
privacy posture; the wire contract is pinned by
`scripts/uitest/telemetry-check.ts`, which is the guardrail — read it alongside
this page.

## Privacy posture

- **Opt-out, on by default in a release.** The **Settings › About › Usage data**
  toggle (the `settings.telemetry` target, at the bottom of the About page;
  persisted in the proxy's state file) can turn it off; `WEBUI_TELEMETRY=false`
  is a hard kill that wins over the toggle. "On" means the release you installed
  **baked an ingest key at publish time** (`bun run gen:telemetry-key`); a
  **source checkout has no key and sends nothing** until `WEBUI_TELEMETRY_KEY`
  is set, and a compiled binary is inert by channel (see *Release-gated*).
- **Server-side only.** The browser holds no telemetry credential and sends
  nothing itself — the toggle and the About "Usage data" block talk to a proxy
  route that owns the key.
- **Coarse, non-identifying data only.** A random per-install `instance_id`
  (used only to de-duplicate heartbeats), the app version, deployment form
  (`docker`/`bare`), OS/CPU/arch **family**, CPU count, RAM rounded **up** to
  whole GB, uptime, and aggregate counts (sessions, installed extensions).
  Never hostnames, exact OS/kernel/disk details, environment variables, IP
  addresses, file paths, session titles, prompts, message content, model output,
  or any other user content.
- **Release-gated.** Only a published npm release sends. A repo checkout, a
  compiled binary, and a sandbox are inert — the webui equivalent of Quickly's
  dev `_app_version() -> "unknown"` refusal. `package.json` is the version
  source, read once at boot.
- **Fail-open.** A short timeout, every error swallowed, and the heartbeat is
  the only thing affected — it never blocks boot or a request.

## Wire contract

`POST {url}/v1/telemetry`, header `X-Quickly-Key: <ingest key>`. The key is a
low-privilege ingestion filter, **not** a security boundary (the same model as
Quickly), so a baked default is acceptable. `PAYLOAD_KEYS` is the explicit
top-level allowlist:

```
schema_version, product, instance_id, app_version, seq, sent_at,
deployment, os, arch, cpu_count, ram_gb, heartbeat, daily, events, features
```

`product` is `"opencode-webui"`. `heartbeat` carries `sessions_count`,
`extensions_count`, `uptime_days`; `daily` is empty; `events` is
`setup_completed`; `features` are `extensions` / `dom_extensions` /
`proxy_extensions` (only when used).

### Sequence / idempotency

`seq` is persisted and advanced **only after a 2xx**, so a lost response causes
a replay with the same sequence, which the hub de-duplicates rather than
double-counting.

### State

Durable, mode-0600 JSON at
`${XDG_STATE_HOME:-~/.local/state}/opencode-webui/telemetry.json`:
`{ instanceId, seq, enabled, firstSeen }`. It never contains user content.

## Hub dependency (landed)

The hub is shared with Quickly and now carries a product discriminator. The
`product` field on the payload (a bare `"opencode-webui"`, defaulting to
`"quickly"` for a legacy payload) selects the event/feature vocabulary the hub
validates against, so a webui payload with webui-only names is accepted and a
Quickly-only name is rejected — per product.

### A client release may precede a hub deploy

The hub gates event/feature names against its per-product vocabulary and answers
**422** for a name it does not know yet. A new client talking to an older hub
would otherwise send nothing. `postPayload` handles this: on a 422 where the
payload carried `events` or `features`, it retries **once** with both lists
empty. The version/scale heartbeat still lands (fail-open), and the `seq` is
unchanged so the retry stays idempotent. A 422 with nothing to drop is a plain
failure — no loop. This is proven by `check:telemetry`.

## Product notices (announcements + release notes)

Separately from the heartbeat, the proxy exposes `GET /api/webui/notices`
(`server/notices.ts`): a cached, fail-open read of the hub's **public**
product-scoped feeds — `/v1/announcements?product=opencode-webui` (ad-hoc
messages) and `/v1/versions?product=opencode-webui` (release notes / What's
New). No key is sent, nothing about the install leaves the machine, and it is
deliberately **not** gated on the telemetry opt-out (a security notice must
reach a telemetry-off user). The page renders it on the `update.notice` surface
— see `docs/reference/notices.md`.

## Configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `WEBUI_TELEMETRY` | unset | `false` (or `0`/`no`/`off`) hard-disables telemetry; wins over the toggle. |
| `WEBUI_TELEMETRY_URL` | `https://telemetry.shortformfunnels.com` | Hub base URL. |
| `WEBUI_TELEMETRY_KEY` | empty | Ingest key **override** (a test/staging hub, a local run). Empty ⇒ fall through to the release-baked key, then to no sending. |

The key a released install uses is **baked at publish time**: `prepublishOnly`
runs `bun run gen:telemetry-key`, which writes `dist/telemetry-key.json` from
`WEBUI_TELEMETRY_KEY` and **fails the publish when it is unset** — an artifact
that would collect nothing must never ship silently (3.4.0/3.4.1 did, and every
gate stayed green). `dist/` is packed into the tarball *and* gitignored, so the
key travels in the release and never in git — the same shape Quickly uses
(build-time `QUICKLY_TELEMETRY_KEY`). Runtime resolution order:
`WEBUI_TELEMETRY_KEY` → `dist/telemetry-key.json` → `DEFAULT_TELEMETRY_KEY` (empty).

## Routes

- `GET /api/webui/telemetry` → `{ enabled, envDisabled, active, release, configured, url, version, instanceId }`
- `PUT /api/webui/telemetry` `{ enabled }` → same shape (the toggle).

Both sit behind the same session auth as every other `/api/webui/*` route, and
neither ever returns the key; the static handler refuses
`GET /telemetry-key.json` too. The key's real nature: it is **baked into the
published tarball** (that is the point) and it is the hub's **global**
`HUB_WRITE_KEY`, shared by every product on that hub. It is an ingestion filter,
not a credential and not a security boundary.

## Checks

- `bun run check:telemetry` — offline contract: allowlist, forbidden-key scan,
  release-gating, the env hard-kill, idempotent `seq`, and a static
  no-device-identity scan.
- `bun run check:telemetry:live` — POSTs a real payload (add `--compat` for a
  hub that predates the `product` field).
