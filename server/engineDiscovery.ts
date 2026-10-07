/**
 * Spawn-free engine discovery — the registration fallback, shared.
 *
 * `Service.discover()` validates a candidate through the engine's `/api/health`
 * plus its version handshake. When the engine's HTTP surface has drifted from
 * this client — e.g. a newer engine that no longer serves `/api/health` — that
 * validation fails, and the spawn-capable `Service.ensure()` throws
 * `TypeError: body is not an Object` inside its own probe. Meanwhile the engine
 * sits healthy in the registration file.
 *
 * The proxy must not answer 502 in that case, and the API-sync scripts
 * (`fetch-openapi.ts` / `diff-openapi.ts`) must still be able to find the
 * engine to compute drift. So the fallback lives here and both consume it —
 * one method per concern, no second copy of the registration parser.
 *
 * Strictly spawn-free: nothing in this module calls `Service.ensure()`.
 */

import { Service } from "@opencode/client/service";
import type { EngineEndpoint } from "./engineResolver";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type { EngineEndpoint };

/** Loopback / unspecified engine host? The registration file is machine-local. */
export function isLocalEngineUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "::" ||
      host === "0.0.0.0" ||
      // Exact IPv4 loopback only — a bare `^127\.` prefix would accept a
      // hostname like `127.0.0.1.attacker.tld` (which resolves remotely).
      /^127(\.\d{1,3}){3}$/.test(host) ||
      // WHATWG canonicalizes an IPv4-mapped IPv6 host to hex, so
      // `[::ffff:127.0.0.1]` arrives as `::ffff:7f00:1`.
      host === "::ffff:7f00:1"
    );
  } catch {
    return false;
  }
}

/** Spawn-free fallback: the registration file, if its pid is still alive. */
export function registrationEndpoint(): EngineEndpoint | undefined {
  try {
    const stateDir = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const raw = readFileSync(join(stateDir, "opencode", "service.json"), "utf8");
    const info = JSON.parse(raw) as { url?: unknown; password?: unknown; pid?: unknown };
    if (typeof info.url !== "string" || info.url.length === 0) return undefined;
    if (typeof info.pid === "number") {
      try {
        process.kill(info.pid, 0); // alive?
      } catch {
        return undefined; // stale registration — never adopt a dead record
      }
    }
    const url = info.url.replace(/\/+$/, "");
    // A registration record is written by a LOCAL engine. Refuse a non-local URL
    // rather than let the proxy forward every authenticated request — and the
    // engine password — to wherever a tampered record points (SSRF / credential
    // leak). Loopback + unspecified addresses are the only valid targets here.
    if (!isLocalEngineUrl(url)) return undefined;
    const password = typeof info.password === "string" && info.password.length > 0 ? info.password : undefined;
    return password ? { url, auth: { type: "basic", username: "opencode", password } } : { url };
  } catch {
    return undefined;
  }
}

/**
 * Discovery first, registration fallback second. Never spawns. The optional
 * `log` is the caller's debug sink (the proxy passes its `dbg`).
 */
export async function discoverEngine(log?: (message: string) => void): Promise<EngineEndpoint | undefined> {
  const found = await Service.discover().catch(() => undefined);
  if (found) return found;
  const fallback = registrationEndpoint();
  if (fallback) log?.(`engine discovery: Service.discover() found nothing; using registration file (${fallback.url})`);
  return fallback;
}

/**
 * Resolve a usable engine endpoint for scripts and tooling: spawn-free
 * discovery, and only if that finds nothing, the spawn-capable `Service.ensure()`.
 * Returns an endpoint whose auth `Service.headers(ep)` understands.
 *
 * Throws when the engine is genuinely unreachable.
 */
export async function resolveEngineEndpoint(log?: (message: string) => void): Promise<EngineEndpoint> {
  const found = await discoverEngine(log);
  if (found) return found;
  return await Service.ensure();
}
