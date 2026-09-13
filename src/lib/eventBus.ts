/**
 * The extension event bus (roadmap item 3) — the one place extensions observe
 * what happened, instead of diffing whole-store snapshots off a firehose.
 *
 * Two families of names ride the same channel:
 *
 *  - **Raw engine events** — every event the store's `handleEvent` reduces,
 *    published under its engine `type` (e.g. `session.tool.success`,
 *    `session.text.delta`, `permission.asked`, `session.idle`). Payload is the
 *    event's `data`; `sessionID`/`created` are lifted for convenience.
 *  - **Derived lifecycle events** — a small stable set core computes so
 *    extensions don't have to infer them:
 *      - `run.started`      `{ sessionID }`
 *      - `run.ended`        `{ sessionID, reason }`  reason = terminal engine
 *                            type or `"idle"`
 *      - `tool.called`      `{ sessionID, assistantMessageID, id, name, input? }`
 *      - `tool.completed`   `{ sessionID, assistantMessageID, id, name?, ok }`
 *      - `message.appended` `{ sessionID, messageID, type }`
 *    (`permission.asked` / `session.idle` are the raw engine events — no
 *    derived duplicate exists, so a subscriber sees each exactly once.)
 *
 * Subscribe with an exact name or `"*"` (wildcard, everything). Delivery is
 * frame-batched (16ms) to match the app's SSE batching, so a token burst
 * produces one dispatch per listener per frame rather than one per token.
 * A throwing listener is isolated — it can never break the publisher or its
 * peers.
 *
 * The bus is a *notification* channel: it never mutates state and extensions
 * cannot publish. To act, use the store/api surface.
 */

export interface BusEvent {
  /** A raw engine `type` or a derived lifecycle name. */
  name: string;
  /** Session id when the event carries one. */
  sessionID?: string;
  /** Engine `data` for raw events; the documented shape for derived ones. */
  payload: unknown;
  /** Event timestamp (epoch ms) when known. */
  created?: number;
}

export type BusListener = (event: BusEvent) => void;

const listeners = new Map<string, Set<BusListener>>();
const wildcards = new Set<BusListener>();

const queue: BusEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FRAME_MS = 16;

/**
 * Subscribe to one event name (or `"*"`). Returns an unsubscribe; the context
 * wires this into extension disposal so a hot-swap/disable leaves no listeners.
 */
export function subscribeEvents(pattern: string, listener: BusListener): () => void {
  if (pattern === "*") {
    wildcards.add(listener);
    return () => {
      wildcards.delete(listener);
    };
  }
  let set = listeners.get(pattern);
  if (!set) {
    set = new Set();
    listeners.set(pattern, set);
  }
  const owned = set;
  owned.add(listener);
  return () => {
    owned.delete(listener);
    if (owned.size === 0) listeners.delete(pattern);
  };
}

/** Publish an event to the bus. Core-only; queue is drained on the next frame. */
export function publishEvent(
  name: string,
  opts: { sessionID?: string; payload: unknown; created?: number },
): void {
  queue.push({ name, sessionID: opts.sessionID, payload: opts.payload, created: opts.created });
  if (!flushTimer) flushTimer = setTimeout(flushEvents, FRAME_MS);
}

/** Drain the pending queue now (also used by tests). Normally frame-scheduled. */
export function flushEvents(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const batch = queue.splice(0);
  for (const event of batch) {
    const set = listeners.get(event.name);
    if (set) for (const fn of [...set]) deliver(fn, event);
    for (const fn of [...wildcards]) deliver(fn, event);
  }
}

function deliver(fn: BusListener, event: BusEvent): void {
  try {
    fn(event);
  } catch (err) {
    console.error(`[events] listener for "${event.name}" failed:`, err);
  }
}

/** Number of live subscriptions (diagnostics/tests). */
export function eventSubscriberCount(): number {
  let n = wildcards.size;
  for (const set of listeners.values()) n += set.size;
  return n;
}
