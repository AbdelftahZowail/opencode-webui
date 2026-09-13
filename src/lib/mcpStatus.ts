/**
 * Global MCP status cache.
 *
 * The MCP indicator sits in the per-session conversation header, which is
 * remounted on every session switch (and once per split pane). Fetching from
 * the component meant a network round-trip — and a loading flash — on every
 * switch/refresh. This module owns ONE snapshot and ONE scheduler poller; the
 * indicator is a pure subscriber, so switching sessions paints instantly from
 * cache and the network is touched on a single cadence app-wide.
 */
import type { McpServer } from "../api/client";
import { api } from "../api/client";
import { registerPoller } from "./scheduler";

export interface McpStatusSnapshot {
  servers: McpServer[] | null;
  error: string | null;
  /** 0 = never loaded. */
  updatedAt: number;
}

let snapshot: McpStatusSnapshot = { servers: null, error: null, updatedAt: 0 };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let started = false;

/** Render-from-cache window; beyond this a remount kicks a background refresh. */
const STALE_MS = 20_000;

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeMcpStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stable reference between refreshes (useSyncExternalStore contract). */
export function getMcpStatus(): McpStatusSnapshot {
  return snapshot;
}

/** Fetch once; concurrent callers share the in-flight request. */
export function refreshMcpStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await api.mcpList();
      snapshot = { servers: res.data, error: null, updatedAt: Date.now() };
    } catch (e: unknown) {
      // Keep the last good list; surface the error alongside it.
      snapshot = {
        servers: snapshot.servers,
        error: e instanceof Error ? e.message : String(e),
        updatedAt: snapshot.updatedAt,
      };
    } finally {
      inFlight = null;
      emit();
    }
  })();
  return inFlight;
}

/**
 * Idempotent global setup: warms the cache and starts ONE poller for the app
 * lifetime. Safe to call from anywhere (boot + every indicator mount).
 */
export function ensureMcpStatus(): void {
  if (started) return;
  started = true;
  void refreshMcpStatus();
  // Cadence rides the shared LIVE/IDLE/HIDDEN tiers: quick while a run is
  // active, gentle when idle, quiet when the tab is hidden.
  registerPoller({
    name: "mcp-status",
    minInterval: 10_000,
    intervals: { live: 10_000, idle: 30_000, hidden: 60_000 },
    run: () => refreshMcpStatus(),
  });
}

/** Refetch only when the cache is missing or stale — never on a plain remount. */
export function ensureMcpStatusFresh(): void {
  if (snapshot.updatedAt === 0 || Date.now() - snapshot.updatedAt > STALE_MS) {
    void refreshMcpStatus();
  }
}
