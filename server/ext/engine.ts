/**
 * Engine credential helper (proxy stratum).
 *
 * `server.ts` authors hand-parsed `service.json` to call the engine (third
 * occurrence → kit by the IN-4 rule). Use `ctx.engine` instead — no core
 * import needed on the extension side; the context shape is structural:
 *
 * ```ts
 * // my-extension/server.ts — no imports needed
 * export default {
 *   pollers: [
 *     {
 *       id: "watch",
 *       intervalMs: 30_000,
 *       run: async (ctx) => {
 *         const res = await ctx.engine.fetch("/api/session/active");
 *         if (!res.ok) return; // engine momentarily unreachable — retry next tick
 *         const { data } = (await res.json()) as { data?: unknown };
 *         await ctx.kv.set("lastSeen", Date.now());
 *       },
 *     },
 *   ],
 * };
 * ```
 *
 * Discovery mirrors `Service.ensure()`'s registration file
 * (`$XDG_STATE_HOME/opencode/service.json`, default
 * `~/.local/state/opencode/service.json`, `{ url, password }`), with
 * explicit env winning per knob:
 *
 * - URL: `WEBUI_ENGINE_URL` wins, else the file's `url`. Trailing slashes
 *   are stripped. `null` when neither exists (engine never ran here).
 * - Password: `WEBUI_ENGINE_PASSWORD` wins. With an explicit URL override
 *   the file password is deliberately NOT reused — a chosen engine has its
 *   own credential, and falling back to the default state file's password
 *   would send the wrong secret (the stale-pid rogue-serve incident).
 *   Without an override the file password applies. Empty = no auth.
 *
 * Auth is HTTP Basic (`opencode:<password>`), the same header
 * `Service.headers()` builds. The proxy's own discovery path
 * (`serviceEndpoint()` in `server/index.ts`) honors the same overrides via
 * `resolveEngineOverride()` — and an override URL skips `Service.ensure()`
 * entirely, so a stale `service.json` pid can never spawn a rogue serve.
 *
 * Node builtins only (`node:fs`/`node:os`/`node:path` + global
 * `fetch`/`Buffer`) — this module creates no import cycle with
 * `server/index.ts`, which is why the credential logic lives here and not
 * behind `Service`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtEngine } from "./types";

export const ENGINE_USERNAME = "opencode";
export const ENGINE_REQUEST_TIMEOUT_MS = 15_000;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function serviceFilePath(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(state, "opencode", "service.json");
}

/** Raw registration-file read. Never throws — absent/corrupt = null. */
function readServiceFile(): { url?: unknown; password?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(serviceFilePath(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed as { url?: unknown; password?: unknown };
    return null;
  } catch {
    return null;
  }
}

/**
 * Effective engine base URL: `WEBUI_ENGINE_URL` wins, else the registration
 * file's `url`. `null` when neither exists.
 */
export function resolveEngineBaseUrl(): string | null {
  const override = nonEmpty(process.env.WEBUI_ENGINE_URL);
  if (override !== undefined) return override.replace(/\/+$/, "");
  const info = readServiceFile();
  if (info && typeof info.url === "string" && info.url.length > 0) {
    return info.url.replace(/\/+$/, "");
  }
  return null;
}

/**
 * Effective engine password: `WEBUI_ENGINE_PASSWORD` wins; with an explicit
 * URL override there is no file fallback (see module doc); otherwise the
 * registration file's password. `undefined` = no auth.
 */
export function resolveEnginePassword(): string | undefined {
  const override = nonEmpty(process.env.WEBUI_ENGINE_PASSWORD);
  if (override !== undefined) return override;
  if (nonEmpty(process.env.WEBUI_ENGINE_URL) !== undefined) return undefined;
  const info = readServiceFile();
  return typeof info?.password === "string" && info.password !== "" ? info.password : undefined;
}

/** Auth headers for the engine — the same Basic header `Service.headers()` builds. */
export function engineAuthHeaders(): Record<string, string> {
  const password = resolveEnginePassword();
  if (password === undefined) return {};
  return { authorization: "Basic " + Buffer.from(`${ENGINE_USERNAME}:${password}`).toString("base64") };
}

/**
 * Override endpoint for the proxy's own discovery path. Non-null iff
 * `WEBUI_ENGINE_URL` is set — explicit env wins, and the caller must skip
 * `Service.ensure()` (no spawn, no version-kill of the chosen engine).
 * Shape matches the `Endpoint` type `Service.ensure()` resolves to.
 */
export function resolveEngineOverride(): {
  url: string;
  auth?: { type: "basic"; username: string; password: string };
} | null {
  const raw = nonEmpty(process.env.WEBUI_ENGINE_URL);
  if (raw === undefined) return null;
  const url = raw.replace(/\/+$/, "");
  const password = nonEmpty(process.env.WEBUI_ENGINE_PASSWORD);
  if (password === undefined) return { url };
  return { url, auth: { type: "basic", username: ENGINE_USERNAME, password } };
}

/**
 * Fetch against the engine (`/api/...` paths; a leading slash is optional).
 * Caller headers are kept; engine auth always wins over a caller-supplied
 * `authorization` (same rule as the proxy passthrough). Aborts after
 * `ENGINE_REQUEST_TIMEOUT_MS` unless the caller passes its own signal.
 * Throws with a remedy when the engine is undiscoverable; HTTP errors are
 * returned (not thrown) so pollers can retry next tick.
 */
export async function engineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = resolveEngineBaseUrl();
  if (!base) {
    throw new Error(
      "[webui] engine undiscoverable: set WEBUI_ENGINE_URL or start the opencode service (no service.json found)",
    );
  }
  const { headers: initHeaders, signal, ...rest } = init;
  const headers = new Headers(initHeaders);
  for (const [k, v] of Object.entries(engineAuthHeaders())) headers.set(k, v);
  return fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
    ...rest,
    headers,
    signal: signal ?? AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
  });
}

/** The singleton wired into every `ExtServerContext` as `ctx.engine`. */
export const engine: ExtEngine = {
  baseUrl: resolveEngineBaseUrl,
  headers: engineAuthHeaders,
  fetch: engineFetch,
};
