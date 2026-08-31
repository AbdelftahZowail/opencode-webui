/**
 * The fetch/tick scheduler — the ONLY owner of recurring timers in the app
 * (besides one-shot UX timeouts, the 16ms event flush, and the SSE stall
 * fuse in api/events.ts).
 *
 * Why: correctness concerns each grew their own setInterval over time —
 * ~8 overlapping channels, unconditional sweeps while idle, N+1 loops, and
 * reconnect bursts that fired MORE sweeps. This module replaces them with
 * ONE loop that evaluates a tier every second and runs each registered
 * poller no more often than its tier allows:
 *
 *   LIVE    ~2s   — any session running/queued/pending/live, or the SSE
 *                   push channel looks stale (no bytes for 30s; heartbeats
 *                   arrive every ~15s on a healthy connection)
 *   IDLE    ~12s  — visible tab, nothing streaming
 *   HIDDEN  ~60s  — document.hidden (Chrome throttles background timers
 *                   anyway; this just keeps the network quiet to match)
 *
 * Components and the store stop owning setInterval: they register a poller
 * and get an unregister function back. Components keep their own local
 * view-state; timing is the scheduler's only job. Everything else about the
 * data model is untouched — this is a scheduling layer, not a state change.
 *
 * Pollers get their first run staggered (±jitter at registration) so
 * same-cadence pollers don't align into bursts, and an in-flight guard so a
 * slow run never stacks with itself.
 */

import { log } from "./log";

export type Tier = "live" | "idle" | "hidden";

export interface PollerOptions {
  /** Stable name for debug logs. */
  name: string;
  /** Floor across all tiers — a tier override can stretch but never go below. */
  minInterval: number;
  /** Per-tier cadence overrides; missing tiers fall back to minInterval. */
  intervals?: Partial<Record<Tier, number>>;
  /** Run while the tab is hidden (default false — most polls can wait). */
  whenHidden?: boolean;
  /** The work. May be async; rejections are caught and logged. */
  run: () => unknown;
}

interface Poller {
  name: string;
  minInterval: number;
  intervals: Partial<Record<Tier, number>>;
  whenHidden: boolean;
  run: () => unknown;
  lastRun: number;
  inFlight: boolean;
}

const pollers = new Map<number, Poller>();
let nextPollerId = 1;
let timer: ReturnType<typeof setInterval> | null = null;
let signals: { isBusy: () => boolean; isSseStale: () => boolean } | null = null;

const TICK_MS = 1_000;

function currentTier(): Tier {
  if (typeof document !== "undefined" && document.hidden) return "hidden";
  if (!signals) return "live"; // not wired yet — assume the fast tier
  return signals.isBusy() || signals.isSseStale() ? "live" : "idle";
}

function intervalFor(p: Poller, tier: Tier): number {
  return Math.max(p.minInterval, p.intervals[tier] ?? p.minInterval);
}

function runPoller(p: Poller, now: number) {
  p.lastRun = now;
  p.inFlight = true;
  let result: unknown;
  try {
    result = p.run();
  } catch (err) {
    p.inFlight = false;
    log("poll", `${p.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (result instanceof Promise) {
    void result
      .catch((err: unknown) => {
        log("poll", `${p.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        p.inFlight = false;
      });
  } else {
    p.inFlight = false;
  }
}

function tick() {
  const tier = currentTier();
  const now = Date.now();
  for (const p of pollers.values()) {
    if (tier === "hidden" && !p.whenHidden) continue;
    if (p.inFlight) continue;
    if (now - p.lastRun < intervalFor(p, tier)) continue;
    runPoller(p, now);
  }
}

/** Wires the tier signals and starts the one loop. Idempotent. */
export function startScheduler(s: { isBusy: () => boolean; isSseStale: () => boolean }): void {
  signals = s;
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  // Coming back to a visible tab should catch up within a tick, not wait out
  // the current interval (the old per-component visibilitychange listeners).
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
}

function onVisibility() {
  if (!document.hidden) tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

/** Registers a recurring poller; returns its unregister function. */
export function registerPoller(opts: PollerOptions): () => void {
  const id = nextPollerId++;
  const p: Poller = {
    name: opts.name,
    minInterval: opts.minInterval,
    intervals: opts.intervals ?? {},
    whenHidden: opts.whenHidden ?? false,
    run: opts.run,
    // Stagger the FIRST due time so same-cadence pollers don't align into
    // bursts (boot registers several at once).
    lastRun: Date.now() - Math.random() * opts.minInterval,
    inFlight: false,
  };
  pollers.set(id, p);
  return () => {
    pollers.delete(id);
  };
}

// Hot-editing this file must not leak the old loop: Vite re-evaluates the
// module (fresh `timer === null`) while the previous interval keeps firing.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopScheduler());
}
