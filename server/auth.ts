/**
 * Access control for the webui proxy.
 *
 * One password (WEBUI_PASSWORD, or auto-generated on a loopback bind) → one
 * session cookie. Design constraints:
 *
 * - The password is NEVER stored or compared in plaintext: only its SHA-256
 *   digest is kept in memory and verified via crypto.timingSafeEqual.
 * - Session tokens are HMAC-signed (`payload.sig`, both base64url) with a
 *   32-byte secret persisted at ~/.local/state/opencode-webui/secret.key
 *   (chmod 600) so sessions survive proxy restarts. No plaintext secret ever
 *   leaves this module, and no password or token is ever logged.
 * - DNS-rebinding: the Host header is validated on EVERY request (loopback
 *   names + the configured bind host, plus the reverse-proxy-forwarded
 *   X-Forwarded-Host when present). State-changing methods additionally get
 *   an Origin check: same-origin or no Origin (curl/scripts) passes.
 * - Login attempts are rate-limited per peer IP: 5 failures/min, then 429
 *   with Retry-After. A successful login clears the counter.
 *
 * This module is deliberately engine-agnostic: it never talks to the
 * opencode service.
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSION_COOKIE = "webui_session";
/** 30 days — matches the Max-Age the login cookie advertises. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 2592000
const SECRET_STATE_DIR = "opencode-webui";

// Rate limiting: fixed 60s window that starts at the first failure.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_FAILURES = 5;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function stateBaseDir(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

/**
 * The HMAC secret for session tokens, persisted across restarts so a login
 * outlives `bun run --watch` (which restarts this process on every edit).
 * Created on first boot with mode 600; a corrupt file is replaced.
 */
export function loadSecret(): Buffer {
  const dir = join(stateBaseDir(), SECRET_STATE_DIR);
  const file = join(dir, "secret.key");
  try {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort hardening */
  }
  try {
    const hex = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* keep going with whatever perms exist */
      }
      return Buffer.from(hex, "hex");
    }
  } catch {
    /* ENOENT — first boot, fall through to create */
  }
  const key = randomBytes(32);
  try {
    writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    // A read-only state dir still yields a working server — sessions just
    // won't survive restarts (a fresh secret invalidates old cookies).
    console.error("[webui] could not persist session secret (sessions reset on restart):", err instanceof Error ? err.message : err);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

export type AuthPolicy = {
  /** SHA-256 digest of the effective password — the ONLY thing kept. */
  digest: Buffer;
  /** Set when the password was generated here (printed once, then forgotten). */
  generated?: string;
};

/**
 * Resolve the password policy at boot. WEBUI_PASSWORD wins; on a wildcard
 * bind with none set we REFUSE to start rather than expose an unauthenticated
 * proxy to the network. Loopback binds get a generated passphrase that is
 * GENERATED ONCE and then persisted (0600) next to the HMAC secret, so
 * restarts keep working without a new password to hunt for in logs.
 */
export function resolveAuthPolicy(host: string): AuthPolicy {
  const fromEnv = process.env.WEBUI_PASSWORD;
  if (fromEnv && fromEnv.length > 0) {
    return { digest: createHash("sha256").update(fromEnv, "utf8").digest() };
  }
  if (process.env.WEBUI_SANDBOX === "1") {
    // Sandbox mode: loopback-only, no password. The bind address is the
    // guarantee — a non-loopback sandbox is a misconfiguration, refuse it.
    if (!isLoopbackHostname(hostnameOf(host)) && !isLoopbackHostname(host)) {
      console.error(`[webui] sandbox requires a loopback bind — refusing ${host}`);
      process.exit(1);
    }
    return { digest: Buffer.alloc(0) };
  }
  if (isWildcardHostname(hostnameOf(host))) {
    console.error(`[webui] refusing ${host} without WEBUI_PASSWORD — set it or keep the loopback bind`);
    process.exit(1);
  }
  const generated = loadOrGeneratePassword();
  return { digest: createHash("sha256").update(generated, "utf8").digest(), generated };
}

/** State dir shared with the HMAC secret (created by loadSecret). */
const STATE_DIR = join(stateBaseDir(), "opencode-webui");
const PASSWORD_FILE = join(STATE_DIR, "generated-password");

function loadOrGeneratePassword(): string {
  try {
    const existing = readFileSync(PASSWORD_FILE, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* first boot — generate below */
  }
  const password = generatePassphrase();
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PASSWORD_FILE, password + "\n", { mode: 0o600 });
  } catch {
    /* unwritable state dir — password still works for this boot */
  }
  return password;
}

export function verifyPassword(input: string, digest: Buffer): boolean {
  const candidate = createHash("sha256").update(input, "utf8").digest();
  return timingSafeEqual(candidate, digest);
}

/**
 * Diceware-style passphrase: 6 words from a 132-word list ≈ 42 bits, joined
 * with "-". Combined with the per-IP rate limit (5 tries/min) that is far
 * beyond brute-force reach for a local tool, and much friendlier to type
 * than hex.
 */
const WORDS = (
  "amber anchor apple arrow aspen atlas audio autumn " +
  "basil beach birch bison bloom blush brave breeze " +
  "cactus camel canyon cargo cedar chili cider cinder " +
  "citrus clover cobalt comet coral cosmic cotton crane " +
  "creek crimson cypress dahlia dawn delta dune ember " +
  "emerald fable falcon fern fjord flint forest fossil " +
  "galaxy garnet gecko ginger glacier granite grove harbor " +
  "hazel heron hickory honey indigo ivory jasper jungle " +
  "juniper kayak kernel lagoon lantern lemon lilac linen " +
  "lotus lynx magma mango maple marble meadow mesa " +
  "meteor mint mirage mosaic nebula nectar noble nomad " +
  "oasis olive onyx orbit orchid otter paddle palm " +
  "pearl pebble pine pixel plum polar prism quail " +
  "quartz quill radish raven reef ridge river robin " +
  "rocky rosemary rusty sable sage salmon sapphire shadow " +
  "sierra silver slate solar spruce summit tulip umber " +
  "velvet willow zephyr zenith"
).split(/\s+/);

export function generatePassphrase(): string {
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    words.push(WORDS[randomInt(WORDS.length)] ?? "opencode");
  }
  return words.join("-");
}

// ---------------------------------------------------------------------------
// Session tokens: base64url(payload) + "." + base64url(HMAC-SHA256(payload))
// ---------------------------------------------------------------------------

export function signToken(secret: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string, secret: Buffer): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest();
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: number;
      exp?: number;
    };
    return parsed.v === 1 && typeof parsed.exp === "number" && parsed.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export function isAuthed(req: Request, secret: Buffer): boolean {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return false;
  return verifyToken(token, secret);
}

// ---------------------------------------------------------------------------
// Sandbox (passwordless loopback instance)

/** True when this instance runs in SANDBOX mode: loopback-only bind, no
 * password, full access for anything on the host (agents, scripts). Set via
 * the `sandbox` argv or WEBUI_SANDBOX=1; a non-loopback bind is refused.
 * A function, not a const: the `sandbox` argv block in index.ts runs before
 * this module's constants (imports hoist), so this must read env lazily. */
export function SANDBOX(): boolean {
  return process.env.WEBUI_SANDBOX === "1";
}

export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Rate limiting (per peer IP, in-memory)
// ---------------------------------------------------------------------------

export function rateLimitStatus(ip: string): { limited: boolean; retryAfter: number } {
  const entry = rateBuckets.get(ip);
  if (!entry || Date.now() - entry.windowStart >= RATE_WINDOW_MS) {
    return { limited: false, retryAfter: 0 };
  }
  if (entry.count >= RATE_MAX_FAILURES) {
    return {
      limited: true,
      retryAfter: Math.max(1, Math.ceil((entry.windowStart + RATE_WINDOW_MS - Date.now()) / 1000)),
    };
  }
  return { limited: false, retryAfter: 0 };
}

export function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = rateBuckets.get(ip);
  if (entry && now - entry.windowStart < RATE_WINDOW_MS) entry.count += 1;
  else rateBuckets.set(ip, { count: 1, windowStart: now });
  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
}

export function clearAuthFailures(ip: string): void {
  rateBuckets.delete(ip);
}

// ---------------------------------------------------------------------------
// Host / Origin guards (DNS rebinding + cross-origin state changes)
// ---------------------------------------------------------------------------

/** "localhost:4097" → "localhost"; "[::1]:80" → "::1"; "::1" → "::1". */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  const colons = (h.match(/:/g) ?? []).length;
  if (colons === 0) return h;
  if (colons === 1) return h.slice(0, h.indexOf(":"));
  return h; // bare IPv6 (no port, no brackets)
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function isWildcardHostname(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "*" || hostname === "";
}

function firstHeaderValue(req: Request, name: string): string | undefined {
  const value = req.headers.get(name);
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first || undefined;
}

function forbidden(reason: string): Response {
  return Response.json({ error: "forbidden", reason }, { status: 403 });
}

/**
 * Runs before EVERY route (login included). Returns a 403 Response to reject,
 * or null to continue. X-Forwarded-Host (when present, e.g. behind a reverse
 * proxy) names the public host and is allowed; otherwise the Host header must
 * be a loopback name or the configured bind host — anything else is exactly
 * what a DNS-rebinding attack looks like.
 */
export function guardRequest(req: Request, configuredHost: string): Response | null {
  const forwardedHost = firstHeaderValue(req, "x-forwarded-host");
  const hostHeader = req.headers.get("host") ?? "";
  const effectiveHost = forwardedHost ?? hostHeader;
  if (!effectiveHost) return forbidden("missing host header");

  if (!forwardedHost) {
    const hostname = hostnameOf(hostHeader);
    const allowed =
      isLoopbackHostname(hostname) || hostname === hostnameOf(configuredHost);
    if (!allowed) return forbidden("untrusted host header");
  }

  const method = req.method;
  if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
    const origin = req.headers.get("origin");
    // No Origin = curl/scripts/health checks — allowed. "null" = sandboxed
    // context — UNTRUSTED (a sandboxed iframe can send it); reject rather
    // than skip. Same-origin = pass.
    if (origin && origin !== "null") {
      const proto =
        firstHeaderValue(req, "x-forwarded-proto") ??
        new URL(req.url).protocol.replace(/:$/, "");
      const expected = `${proto}://${effectiveHost}`.toLowerCase();
      const actual = origin.replace(/\/+$/, "").toLowerCase();
      if (actual !== expected) return forbidden("cross-origin request blocked");
    } else if (origin === "null") {
      return forbidden("null origin rejected");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Login page + handlers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/**
 * Where to land after login. Only in-app absolute paths — anything that
 * could leave the origin ("//host", "/\host", non-"/") collapses to "/".
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  let value = raw;
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw — malformed escapes are not a path we honor anyway */
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n\0]/.test(value) ||
    value.length > 512
  ) {
    return "/";
  }
  return value;
}

const LOGIN_CSP = "default-src 'self'; style-src 'unsafe-inline'";

function loginHtmlResponse(opts: { error?: string; next?: string | null; status: number }): Response {
  const next = escapeHtml(safeNext(opts.next));
  const error = opts.error
    ? `      <div class="err">${escapeHtml(opts.error)}</div>\n`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>opencode webui — sign in</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{width:min(360px,90vw);background:#15181d;border:1px solid #262b33;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:16px;margin:0 0 4px;font-weight:600;letter-spacing:.01em}
  p.sub{margin:0 0 20px;color:#8b93a1;font-size:13px}
  label{display:block;font-size:12px;color:#8b93a1;margin-bottom:6px}
  input[type=password]{width:100%;padding:10px 12px;background:#0b0d10;border:1px solid #2c333d;border-radius:8px;color:#e6e8eb;font-size:14px;outline:none}
  input[type=password]:focus{border-color:#4a7dff}
  button{margin-top:14px;width:100%;padding:10px;background:#4a7dff;border:0;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#3d6ef0}
  .err{margin-bottom:14px;padding:9px 12px;background:#3a1d20;border:1px solid #6e2f36;color:#f2a6ad;border-radius:8px;font-size:13px}
</style>
</head>
<body>
<main class="card">
  <h1>opencode webui</h1>
  <p class="sub">Enter your access password.</p>
  <form method="POST" action="/api/auth/login">
    <input type="hidden" name="next" value="${next}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autofocus autocomplete="current-password" required>
${error}    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: opts.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": LOGIN_CSP,
      "cache-control": "no-store",
    },
  });
}

export function loginPageResponse(url: URL): Response {
  return loginHtmlResponse({ next: url.searchParams.get("next"), status: 200 });
}

export function logoutResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/login", "set-cookie": clearSessionCookieHeader() },
  });
}

/** 401 JSON for /api/*, 302 → /login?next=… for pages (dist/, /, dev root). */
export function unauthorizedResponse(url: URL): Response {
  if (url.pathname.startsWith("/api")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const next = encodeURIComponent(safeNext(url.pathname + url.search));
  return new Response(null, { status: 302, headers: { location: `/login?next=${next}` } });
}

/**
 * POST /api/auth/login — accepts JSON `{password, next?}` (programmatic
 * clients) or the login page's form-encoded POST (keeps the page JS-free
 * under its strict CSP). Failures: 401 (HTML with an inline error for form
 * posts), 429 + Retry-After once an IP burns its 5 failures.
 */
export async function handleLogin(
  req: Request,
  ip: string,
  secret: Buffer,
  passwordDigest: Buffer,
): Promise<Response> {
  let wantsHtml = (req.headers.get("content-type") ?? "").includes("form");
  const limit = rateLimitStatus(ip);
  if (limit.limited) {
    const message = `Too many attempts — try again in ${limit.retryAfter}s.`;
    if (wantsHtml) return loginHtmlResponse({ error: message, status: 429 });
    return Response.json(
      { error: message },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } },
    );
  }

  let password = "";
  let next = "";
  try {
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body = (await req.json()) as { password?: unknown; next?: unknown };
      password = typeof body.password === "string" ? body.password : "";
      next = typeof body.next === "string" ? body.next : "";
    } else {
      const form = await req.formData();
      password = String(form.get("password") ?? "");
      next = String(form.get("next") ?? "");
      wantsHtml = true;
    }
  } catch {
    // Generic on purpose — request bodies never reach the log.
    console.error("[webui] login request could not be parsed");
    if (wantsHtml) return loginHtmlResponse({ error: "Bad request.", status: 400 });
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }

  if (!verifyPassword(password, passwordDigest)) {
    recordAuthFailure(ip);
    if (wantsHtml) return loginHtmlResponse({ error: "Incorrect password.", next, status: 401 });
    return Response.json({ error: "incorrect password" }, { status: 401 });
  }

  clearAuthFailures(ip);
  const secure = firstHeaderValue(req, "x-forwarded-proto") === "https";
  const cookie = sessionCookieHeader(signToken(secret), secure);
  const target = safeNext(next);
  if (wantsHtml) {
    return new Response(null, { status: 303, headers: { location: target, "set-cookie": cookie } });
  }
  return Response.json({ ok: true, next: target }, { headers: { "set-cookie": cookie } });
}

/** Peer IP of a request (the honest TCP peer — never a spoofable header). */
export function peerIP(
  req: Request,
  // Structural: avoids depending on Bun's generic Server type here.
  server: { requestIP(req: Request): { address: string } | null },
): string {
  return server.requestIP(req)?.address ?? "unknown";
}
