/**
 * Server-Sent Events from /api/event. The wire format is:
 *   { id, event, data }  with data being a JSON-encoded V2Event.
 * We connect with fetch + ReadableStream (not EventSource) so we control
 * reconnection and can forward through the proxy without CORS issues.
 */
import { log } from "../lib/log";

export interface RawEvent {
  id: string | null;
  event: string;
  data: string;
}

// The V2Event payloads we render live. Each event carries `type` and `data`.
export interface V2EventData {
  sessionID: string;
  assistantMessageID?: string;
  ordinal?: number;
  delta?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  executed?: boolean;
  content?: unknown[];
  metadata?: Record<string, unknown>;
  error?: { type: string; message: string; status?: number };
  reason?: "user" | "shutdown" | "superseded";
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  finish?: string;
  cost?: number;
  tokens?: unknown;
  snapshot?: string;
  files?: string[];
  action?: string;
  resources?: string[];
  retryAt?: number;
  at?: number;
}

export interface V2Event {
  id: string;
  created: number;
  type: string;
  data: V2EventData;
}

export interface EventEnvelope {
  id: string;
  event: string;
  data: V2Event;
}

// Engine heartbeats arrive every ~15s (measured), so 30s of silence meant
// two missed beats before reconnecting — a run starting inside that window
// was invisible until the catch-up pull. 20s tolerates one lost beat.
const STALL_TIMEOUT_MS = 20_000;

// Health threshold shared with the scheduler: on a healthy connection the
// stream delivers a heartbeat every ~15s, so an age beyond 2× that means the
// push channel is wedged (or dead) even though this fetch hasn't errored.
export const SSE_STALE_MS = 30_000;

// Health signal for the scheduler: wall-clock age of the last byte received
// on the stream (heartbeats included — they are bytes). On a healthy
// connection this never exceeds ~15s, so an age beyond SSE_STALE_MS means
// the push channel is wedged even though the fetch hasn't errored, and REST
// fallbacks should take over until the fuse reconnects.
let lastByteAt = 0;

/** ms since the last byte on the event stream; Infinity before connecting. */
export function sseByteAgeMs(): number {
  return lastByteAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastByteAt;
}

export function sseStale(): boolean {
  return sseByteAgeMs() > SSE_STALE_MS;
}

export async function connectEvents(
  onEvent: (env: EventEnvelope) => void,
  opts: { signal?: AbortSignal; onOpen?: () => void } = {},
): Promise<void> {
  while (!opts.signal?.aborted) {
    let stalled = false;
    let rxBytes = 0; // total bytes this connection received (wedge diagnostics)
    try {
      const res = await fetch("/api/event", { signal: opts.signal });
      if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`);
      log("sse", "connected", res.status);
      lastByteAt = Date.now();
      opts.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const arm = () =>
        setTimeout(() => {
          // If the server channel dies silently (no bytes, no close), the
          // fetch reader would block forever. Force a reconnect instead.
          stalled = true;
          log(
            "sse",
            `STALLED - no data for ${STALL_TIMEOUT_MS / 1000}s (rx=${rxBytes}B total); forcing reconnect`,
          );
          console.warn(`[events] no data for ${STALL_TIMEOUT_MS / 1000}s; forcing reconnect`);
          void reader.cancel();
        }, STALL_TIMEOUT_MS);
      let stallTimer = arm();
      // Events are one JSON payload per `data:` line (probe-verified wire
      // format). If a line does NOT parse alone, hold it and join the next
      // `data:` line — SSE allows payloads split across lines, and dropping
      // such an event silently corrupted the live projection.
      let pendingData: string | null = null;
      const dispatchData = (payload: string) => {
        let parsed: { id?: string | null; created?: number; type?: string };
        try {
          parsed = JSON.parse(payload);
        } catch {
          return false;
        }
        const type = typeof parsed.type === "string" ? parsed.type : null;
        if (!type) return false;
        const v2: V2Event = {
          id: typeof parsed.id === "string" ? parsed.id : "",
          created: typeof parsed.created === "number" ? parsed.created : Date.now(),
          type,
          data: ((parsed as Record<string, unknown>).data ?? {}) as V2EventData,
        };
        onEvent({ id: v2.id, event: type, data: v2 });
        return true;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(stallTimer);
        lastByteAt = Date.now();
        rxBytes += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n");
        buffer = frames.pop() ?? "";
        for (const line of frames) {
          const trimmed = line.trim();
          if (!trimmed) {
            pendingData = null; // separator/heartbeat resets any split buffer
            continue;
          }
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice("data:".length).trim();
          // Join split payloads with NO separator: payloads are JSON, which
          // is whitespace-insensitive, and a mid-token split joined with
          // "\n" would corrupt string contents. (Spec-style multi-line text
          // blocks don't occur on this wire format.)
          if (dispatchData(pendingData ? pendingData + payload : payload)) {
            pendingData = null;
          } else {
            pendingData = pendingData ? pendingData + payload : payload;
          }
        }
        stallTimer = arm();
      }
      // Stream ended cleanly (server closed). Log it — this path used to be
      // silent, which hid reconnect churn behind bare "connected" lines.
      clearTimeout(stallTimer);
      reader.releaseLock();
      if (stalled) throw new Error("event stream stalled");
      log("sse", `stream ended cleanly; reconnecting (rx=${rxBytes}B)`);
    } catch (err) {
      if (opts.signal?.aborted) return;
      log("sse", "reconnect", String(err));
      console.warn("[events] stream ended, reconnecting:", err);
    }
    if (stalled) await new Promise((resolve) => setTimeout(resolve, 500));
    else await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
