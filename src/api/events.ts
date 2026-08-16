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

/**
 * Parse one SSE frame into an envelope. Returns null for heartbeat or
 * malformed frames.
 */
export function parseSseLine(line: string): EventEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === ": heartbeat") return null;
  const body = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
  if (!body) return null;
  let parsed: {
    id?: string | null;
    created?: number;
    type?: string;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (!type) return null;
  const v2: V2Event = {
    id: typeof parsed.id === "string" ? parsed.id : "",
    created: typeof parsed.created === "number" ? parsed.created : Date.now(),
    type,
    data: ((parsed as Record<string, unknown>).data ?? {}) as V2EventData,
  };
  return { id: v2.id, event: type, data: v2 };
}

const STALL_TIMEOUT_MS = 30_000;

export async function connectEvents(
  onEvent: (env: EventEnvelope) => void,
  opts: { signal?: AbortSignal; onOpen?: () => void } = {},
): Promise<void> {
  while (!opts.signal?.aborted) {
    let stalled = false;
    try {
      const res = await fetch("/api/event", { signal: opts.signal });
      if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`);
      log("sse", "connected", res.status);
      opts.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const arm = () =>
        setTimeout(() => {
          // If the server channel dies silently (no bytes, no close), the
          // fetch reader would block forever. Force a reconnect instead.
          stalled = true;
          log("sse", "STALLED - no data for 30s; forcing reconnect");
          console.warn("[events] no data for 30s; forcing reconnect");
          void reader.cancel();
        }, STALL_TIMEOUT_MS);
      let stallTimer = arm();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(stallTimer);
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n");
        buffer = frames.pop() ?? "";
        for (const line of frames) {
          const env = parseSseLine(line);
          if (env) onEvent(env);
        }
        stallTimer = arm();
      }
      clearTimeout(stallTimer);
      reader.releaseLock();
      if (stalled) throw new Error("event stream stalled");
    } catch (err) {
      if (opts.signal?.aborted) return;
      log("sse", "reconnect", String(err));
      console.warn("[events] stream ended, reconnecting:", err);
    }
    if (stalled) await new Promise((resolve) => setTimeout(resolve, 500));
    else await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
