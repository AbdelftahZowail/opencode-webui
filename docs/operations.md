# Reverse proxy

The webui binds `127.0.0.1:4097` by default and is meant to sit behind your
own web server for https. Two things matter:

- **`X-Forwarded-Proto`** must be forwarded — the login cookie is only marked
  `Secure` when the request arrived over https.
- **SSE + long-polls**: the UI holds an open `/api/event` stream (engine
  heartbeats every ~15s keep it alive) and `/api/session/{id}/wait`
  long-polls. Any proxy read timeout must comfortably exceed 30s.

## Caddy

Caddy handles websockets, streaming, and `X-Forwarded-Proto` automatically:

```caddyfile
webui.example.com {
	reverse_proxy 127.0.0.1:4097 {
		# pass streaming bodies (SSE, long-polls) through unbuffered
		flush_interval -1
	}
}
```

## nginx

```nginx
# websocket upgrade helper (PTY terminal and any other /api/* upgrade)
map $http_upgrade $connection_upgrade {
	default upgrade;
	""      close;
}

server {
	listen 443 ssl;
	server_name webui.example.com;
	# ssl_certificate     /etc/ssl/...;
	# ssl_certificate_key /etc/ssl/...;

	location /api/ {
		proxy_pass http://127.0.0.1:4097;
		proxy_http_version 1.1;

		proxy_set_header Host              $host;
		proxy_set_header X-Forwarded-Proto $scheme;   # → Secure cookie flag
		proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

		# websockets (any /api/* path may upgrade, e.g. /api/pty)
		proxy_set_header Upgrade    $http_upgrade;
		proxy_set_header Connection $connection_upgrade;

		# /api/event heartbeats every ~15s. The session/wait long-poll now only
		# sits on the connection while the stream is stale, but keep timeouts
		# well above 30s for the cases where it does.
		proxy_read_timeout 3600s;
		proxy_send_timeout 3600s;

		# stream, don't buffer
		proxy_buffering off;
	}

	location / {
		proxy_pass http://127.0.0.1:4097;
		proxy_set_header Host              $host;
		proxy_set_header X-Forwarded-Proto $scheme;
	}
}
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBUI_HOST` | `127.0.0.1` | Bind address. Leave loopback — only the proxy needs to reach it. `0.0.0.0`/`::` is refused unless `WEBUI_PASSWORD` is set. |
| `WEBUI_ALLOWED_HOSTS` | loopback + bind host | Your public hostname(s), e.g. `webui.example.com` — otherwise the Host guard 403s proxied requests. `*` accepts everything. |
| `WEBUI_TRUST_PROXY` | unset | Set to `1` so `X-Forwarded-Host`/`Proto` from your proxy are honored (needed for the `Secure` cookie flag and correct origin checks when the proxy rewrites `Host`). |
| `WEBUI_PROXY_PORT` | `4097` | Port for the UI and `/api/*` (what your proxy forwards to). |
| `WEBUI_PASSWORD` | generated on first boot, printed once | Shared login passphrase. Set it before exposing the UI beyond localhost. |
| `WEBUI_DEBUG` | unset | `1` — server/proxy debug logs to stdout. |
| `WEBUI_DEBUG_LOG` | `/tmp/webui-debug.log` | File the frontend log sink (`POST /api/debug`) appends to. |
| `WEBUI_TELEMETRY` | unset (on) | `false` (or `0`/`no`/`off`) hard-disables the anonymous usage heartbeat; wins over the Settings toggle. |
| `WEBUI_TELEMETRY_URL` | `https://telemetry.shortformfunnels.com` | Telemetry hub base URL. |
| `WEBUI_TELEMETRY_KEY` | empty | Telemetry ingest key override; a published release **bakes one at publish time and the publish fails without it**. See `docs/reference/telemetry.md`. |

If you must expose the port directly (LAN, no proxy), set `WEBUI_PASSWORD` —
a passwordless wildcard bind is refused at startup.

## Serve/security config (Settings › Security)

`server/config.ts` owns `~/.config/opencode/webui/config.json` (0600): host,
port, auth (`password` | `none`), passwordHash, allowedHosts, trustProxy,
autostart, publicUrl. Precedence per key: explicit env > file > default, so
existing env deployments are untouched. `opencode-webui config get|set|unset`
and Settings › Security edit the same file; `resolveConfig()` returns per-key
`source` provenance, and the UI locks env-pinned fields.

- **Apply = restart**: Bun binds once and the auth digest is in memory, so a
  change never hot-applies; the API returns `restartRequired` and the UI offers
  "Restart now" (the same detached restart the CLI uses).
- **Password optional**: `auth: "none"` is allowed because a user may front the
  proxy with Tailscale/a private network. `analyzeExposure()` drives warnings;
  a *reachable unauthenticated* change (wildcard/non-loopback + no password)
  needs an explicit `confirm: true` (HTTP 409 otherwise). Env and CLI can still
  do it deliberately.
- **Never leak secrets**: the API returns `passwordSet: boolean` only; the file
  holds a SHA-256 `passwordHash`; `WEBUI_PASSWORD` stays plaintext env and wins.
- Proxy-owned routes: `GET/PUT /api/webui/settings` and
  `POST /api/webui/settings/restart` (behind the normal auth gate).
