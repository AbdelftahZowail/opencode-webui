/**
 * Engine endpoint resolution — the fork-storm guard.
 *
 * `Service.ensure()` is not a probe. It runs for up to 120s, spawning a fresh
 * `opencode serve --service` contender every `spawnDelay` (5s, keeping two
 * alive at once), and the contenders it spawns are `detached` + `unref`'d —
 * its failure path only releases their stderr pipes, it never kills them.
 *
 * Called once at boot, that is fine. Called from the request path, it is a
 * fork bomb: when the engine restarts, the proxy drops its memo and every
 * concurrent request re-enters ensure() while it is still failing, each round
 * leaking processes until the host swaps itself to death. 187 engines on an
 * 11GB box, load 268, kswapd0 pinned in D-state, and the engine port held by an
 * unregistered process so the registration file could never be rewritten.
 *
 * Three guards, all required:
 *
 *   1. DISCOVERY FIRST — `Service.discover()` is the spawn-free half of the
 *      same call. A healthy engine (fresh URL or not) is adopted here, so an
 *      engine restart, a flapping event recorder or a second webui instance
 *      can never trigger a spawn, and an engine that comes back is picked up
 *      immediately even while the breaker is open.
 *   2. SINGLE-FLIGHT — concurrent callers share one in-flight ensure().
 *   3. CIRCUIT BREAKER — after a failure, ensure() is not called at all for a
 *      cooldown that doubles per consecutive failure (capped); callers fail
 *      fast instead. A retry storm — browser polls, the event recorder, a
 *      second instance — cannot drive spawning.
 *
 * Pure logic over injected deps so `scripts/uitest/engine-guard-check.ts` can
 * exercise every branch without a live engine.
 */

import type { Endpoint } from "@opencode/client/service";

export type EngineEndpoint = Endpoint;

export type EngineResolverDeps = {
  /** Spawn-free discovery (`Service.discover`). */
  discover: () => Promise<EngineEndpoint | undefined>;
  /** May spawn (`Service.ensure`) — the call these guards exist to bound. */
  ensure: () => Promise<EngineEndpoint>;
  /** Explicit env override; non-null means discovery/ensure are skipped. */
  resolveOverride?: () => EngineEndpoint | null;
  /** Injectable clock (tests). */
  now?: () => number;
  /** First cooldown; doubles per consecutive failure. */
  backoffBaseMs?: number;
  /** Ceiling for the doubling cooldown. */
  backoffMaxMs?: number;
  /** Fires when a new URL is adopted (deduped against the last announced URL). */
  onConnected?: (url: string, suffix: string) => void;
  /** Fires once per failed ensure(), after the cooldown is armed. */
  onFailure?: (input: { error: unknown; failures: number; backoffMs: number }) => void;
  /** Fires when a memoized endpoint is dropped. */
  onInvalidated?: (reason: string) => void;
};

export type EngineResolverState = {
  /** Consecutive ensure() failures; 0 while healthy. */
  readonly failures: number;
  /** Epoch ms before which ensure() may not run again; 0 when closed. */
  readonly retryAt: number;
  /** True while the breaker is open. */
  readonly coolingDown: boolean;
  /** True while an endpoint is memoized. */
  readonly connected: boolean;
};

export type EngineResolver = {
  /** Resolve a usable engine endpoint, or throw an actionable error. */
  endpoint: () => Promise<EngineEndpoint>;
  /** Drop the memo so the next call re-resolves. Never spawns by itself. */
  invalidate: (reason: string) => void;
  /** Breaker/memo snapshot (diagnostics + the guard check). */
  state: () => EngineResolverState;
};

const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export function createEngineResolver(deps: EngineResolverDeps): EngineResolver {
  const now = deps.now ?? Date.now;
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  let current: EngineEndpoint | null = null;
  let ensuring: Promise<EngineEndpoint> | null = null;
  let failures = 0;
  let retryAt = 0;
  let announcedUrl: string | null = null;

  // Deduped: "connected" is worth exactly one line per stretch of health, not
  // one per request in a polling loop.
  function announce(url: string, suffix = ""): void {
    if (announcedUrl === url) return;
    announcedUrl = url;
    deps.onConnected?.(url, suffix);
  }

  function unavailableError(): Error {
    const seconds = Math.max(1, Math.ceil((retryAt - now()) / 1000));
    return new Error(
      `engine unavailable — next start attempt in ${seconds}s ` +
        `(${failures} consecutive failure${failures === 1 ? "" : "s"}; ` +
        "start it with `opencode service start`)",
    );
  }

  async function endpoint(): Promise<EngineEndpoint> {
    // Explicit env wins: no discovery, no spawn, ever. A chosen engine is the
    // operator's business — we never version-kill or replace it.
    const override = deps.resolveOverride?.() ?? null;
    if (override) {
      current = override;
      announce(override.url, " (WEBUI_ENGINE_URL)");
      return override;
    }

    if (current) return current;

    // Guard 1 — spawn-free, and deliberately ahead of the breaker so a
    // returning engine is adopted at once instead of waiting out a cooldown.
    const discovered = await deps.discover().catch(() => undefined);
    if (discovered) {
      current = discovered;
      failures = 0;
      retryAt = 0;
      announce(discovered.url);
      return discovered;
    }

    // Guard 3 — fail fast while the breaker is open: nothing reaches ensure().
    if (now() < retryAt) throw unavailableError();

    // Guard 2 — one in-flight ensure() shared by every concurrent caller.
    if (!ensuring) {
      ensuring = deps
        .ensure()
        .then((resolved) => {
          current = resolved;
          failures = 0;
          retryAt = 0;
          announce(resolved.url);
          return resolved;
        })
        .catch((error: unknown) => {
          failures += 1;
          const backoffMs = Math.min(backoffBaseMs * 2 ** (failures - 1), backoffMaxMs);
          retryAt = now() + backoffMs;
          // Forget the dedupe so recovery re-announces.
          announcedUrl = null;
          deps.onFailure?.({ error, failures, backoffMs });
          throw error;
        })
        .finally(() => {
          ensuring = null;
        });
    }
    return ensuring;
  }

  function invalidate(reason: string): void {
    if (current === null) return;
    current = null;
    deps.onInvalidated?.(reason);
  }

  function state(): EngineResolverState {
    return {
      failures,
      retryAt,
      coolingDown: now() < retryAt,
      connected: current !== null,
    };
  }

  return { endpoint, invalidate, state };
}
