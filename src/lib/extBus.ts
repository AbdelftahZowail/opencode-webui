/**
 * Extension peer bus (roadmap item 9) — extension-to-extension events, so two
 * folders can cooperate without either importing the other.
 *
 * Distinct from the engine event bus (`src/lib/eventBus.ts`): that one carries
 * what CORE observed (engine + lifecycle events) and extensions cannot publish
 * to it. This one is many-to-many between extensions; `from` names the
 * publisher so a subscriber knows who spoke.
 *
 * Channels are plain strings (no registry to maintain). Dropping a folder is
 * an act of trust, so publishing is not authorization-gated — `from` is
 * informational. A throwing subscriber is isolated.
 *
 * Delivery is synchronous: peer messages are low-frequency coordination, not
 * token streams. Subscriptions from an activation context are disposed with it.
 */

export interface PeerEvent {
  /** The channel the event was published on. */
  channel: string;
  /** The publisher's extension id (empty for bridge/anonymous publishes). */
  from: string;
  /** Arbitrary payload. */
  payload: unknown;
}

export type PeerListener = (event: PeerEvent) => void;

const listeners = new Map<string, Set<PeerListener>>();

/** Publish to a channel. `from` is the publisher's id (informational). */
export function publishPeerEvent(channel: string, payload: unknown, from = ""): void {
  const set = listeners.get(channel);
  if (!set || set.size === 0) return;
  const event: PeerEvent = { channel, from, payload };
  for (const fn of [...set]) {
    try {
      fn(event);
    } catch (err) {
      console.error(`[extensions] peer listener on "${channel}" failed:`, err);
    }
  }
}

/** Subscribe to a channel; returns an unsubscribe. */
export function subscribePeerEvents(channel: string, listener: PeerListener): () => void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  const owned = set;
  owned.add(listener);
  return () => {
    owned.delete(listener);
    if (owned.size === 0) listeners.delete(channel);
  };
}

/** Live subscription count (diagnostics/tests). */
export function peerSubscriberCount(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}
