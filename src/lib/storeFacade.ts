/**
 * Curated store facade (roadmap item 4) — the supported surface extensions
 * read and call, so internals stop being the de-facto API by accident.
 *
 * The bridge exposes THIS as `store`; the raw module stays reachable (and
 * explicitly unsupported) as `advanced.store`. Non-React extensions get
 * `subscribe`/`select` here (components use `useStore`).
 *
 * What is here is a deliberate, documented contract: selectors for the common
 * reads (sessions, messages, live/running state, pending requests) and actions
 * for the common writes (send, navigate, answer requests, session lifecycle).
 * Core keeps adding internal state/actions; those do NOT become API — a new
 * need is a deliberate addition to this facade with a version bump.
 */

import * as store from "../store";
import type { State } from "../store";

/** Same shallow-equality contract as the store's `useStore` selector cache. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * Subscribe to a derived value; the listener fires immediately with the
 * current value, then only when the selected value changes (shallow-equal).
 * The non-React analogue of `useStore`.
 */
function select<T>(selector: (s: State) => T, listener: (value: T) => void): () => void {
  let current = selector(store.getState());
  listener(current);
  return store.subscribeStore(() => {
    const next = selector(store.getState());
    if (shallowEqual(current, next)) return;
    current = next;
    listener(next);
  });
}

/**
 * The supported store surface. Grouped: observe → selectors → actions.
 * `getState()` is the full snapshot for anything not covered — read it, but
 * prefer the selectors so an internal reshape doesn't break you.
 */
export const storeFacade = {
  // ---- observe ------------------------------------------------------------
  /** Every store notification (streaming included). Non-React. */
  subscribe: store.subscribeStore,
  /** Derived-value subscribe: immediate + change-gated. Non-React. */
  select,
  /** React hook for shipped/strategy components. */
  useStore: store.useStore,
  /** Full state snapshot (read-only by convention). */
  getState: store.getState,

  // ---- selectors ----------------------------------------------------------
  currentSessionID: (): string | null => store.getState().currentSessionID,
  sessions: () => store.getState().sessions,
  sessionDetail: (sessionID: string) => store.getState().sessionDetails[sessionID],
  messages: (sessionID: string) => store.getState().messages[sessionID] ?? [],
  /** Live streaming projections for one session (empty when none). */
  liveAssistants: (sessionID: string) => store.getState().live.filter((a) => a.sessionID === sessionID),
  isRunning: (sessionID: string): boolean => !!store.getState().running[sessionID],
  isQueued: (sessionID: string): boolean => !!store.getState().queued[sessionID],
  /** Permission requests + questions + forms, in one FIFO (the composer's queue). */
  pendingRequests: () => store.pendingRequests(store.getState()),
  isDraftSession: store.isDraftSession,
  /** Canonical route for a session (`/session/{id}`). */
  sessionHref: store.sessionHref,

  // ---- actions ------------------------------------------------------------
  sendPrompt: store.sendPrompt,
  sendPromptTo: store.sendPromptTo,
  selectSession: store.selectSession,
  navigateFocused: store.navigateFocused,
  newSession: store.newSession,
  materializeDraft: store.materializeDraft,
  replyPermission: store.replyPermission,
  replyForm: store.replyForm,
  replyQuestion: store.replyQuestion,
  rejectQuestion: store.rejectQuestion,
  interrupt: store.interrupt,
  switchAgent: store.switchAgent,
  switchModel: store.switchModel,
  renameSession: store.renameSession,
  compactSession: store.compactSession,
  undoSession: store.undoSession,
  redoSession: store.redoSession,
  activateSkill: store.activateSkill,
} as const;

export type StoreFacade = typeof storeFacade;
