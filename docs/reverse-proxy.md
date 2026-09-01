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

		# /api/event heartbeats every ~15s; session/wait long-polls sit
		# silent for longer — keep timeouts well above 30s
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
| `WEBUI_PROXY_PORT` | `4097` | Port for the UI and `/api/*` (what your proxy forwards to). |
| `WEBUI_PASSWORD` | generated on first boot, printed once | Shared login passphrase. Set it before exposing the UI beyond localhost. |
| `WEBUI_DEBUG` | unset | `1` — server/proxy debug logs to stdout. |
| `WEBUI_DEBUG_LOG` | `/tmp/webui-debug.log` | File the frontend log sink (`POST /api/debug`) appends to. |

If you must expose the port directly (LAN, no proxy), set `WEBUI_PASSWORD` —
a passwordless wildcard bind is refused at startup.
