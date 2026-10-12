/**
 * Session tabs + pins/quick-slots — the PURE tab model (parity.md §5 R3).
 *
 * v2's TUI keeps a window of open sessions as a horizontal/vertical tab rail
 * with per-tab status, a close/reopen stack, and — when tabs are disabled — a
 * set of pinned sessions reachable by number (`session.quick_switch.1..9`).
 * We port that model here as pure data + math so the store's tab actions and
 * the presentational rail agree on ONE implementation (AGENTS rule 2: the store
 * is the only place state lives; this module is the math it calls).
 *
 * Nothing here imports React, the store, or the API. Every function takes the
 * slice and returns a new slice (or a derived value); persistence and event
 * wiring live in the store. Attention/unread derivation takes its inputs
 * (running / permission / question / unread) as arguments, so the same code is
 * exercisable headless and deterministic.
 *
 * Decision (§9.2): tabs are ADDED and split view is KEPT. A tab is an OPEN
 * session in the rail; it is orthogonal to split panes (which pin sessions
 * side-by-side). Selecting a tab routes the focused pane exactly like
 * `selectSession`; the store opens a tab on every successful session select.
 */

// ---------------------------------------------------------------------------
// The slice
// ---------------------------------------------------------------------------

/** Closed-tab stack capacity — v2's "10-entry stack". */
export const TABS_CLOSED_MAX = 10;
/** `session.tab.select.1..10` — ten numbered tab slots. */
export const TAB_SELECT_MAX = 10;
/** `session.quick_switch.1..9` — nine quick slots when tabs are disabled. */
export const QUICK_SLOT_MAX = 9;

/** One entry in the reopen stack: the id and the index it was closed from. */
export interface ClosedTab {
  sessionID: string;
  index: number;
}

/**
 * The tab slice — the whole model, as data. The store owns exactly this and
 * nothing else; everything below is a pure transformation of it.
 *
 * `open` is BOTH the tab window and its order (left→right / top→bottom).
 * `closed` is a reopen stack, newest LAST, capped at `TABS_CLOSED_MAX`.
 * `pins` are ordered quick slots (slot number = index + 1, max 9).
 * `enabled === false` means tabs are off and pins take over.
 */
export interface TabSlice {
  open: string[];
  closed: ClosedTab[];
  pins: string[];
  enabled: boolean;
}

export function emptyTabSlice(): TabSlice {
  return { open: [], closed: [], pins: [], enabled: true };
}

/**
 * Coerce persisted/unknown JSON into a valid slice: drop junk, de-dupe, cap
 * lengths. Used by the store when loading `webui.tabs` from localStorage and
 * safe to call on absent/corrupt data (returns the empty slice).
 */
export function sanitizeTabSlice(raw: unknown): TabSlice {
  const out = emptyTabSlice();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  const stringIds = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

  out.open = [...new Set(stringIds(r.open))];
  out.pins = [...new Set(stringIds(r.pins))].slice(0, QUICK_SLOT_MAX);
  out.closed = (Array.isArray(r.closed) ? r.closed : [])
    .map((c): ClosedTab | null => {
      if (!c || typeof c !== "object") return null;
      const o = c as Record<string, unknown>;
      if (typeof o.sessionID !== "string" || !o.sessionID) return null;
      const index = typeof o.index === "number" && o.index >= 0 ? Math.floor(o.index) : 0;
      return { sessionID: o.sessionID, index };
    })
    .filter((c): c is ClosedTab => c !== null)
    .slice(-TABS_CLOSED_MAX);
  out.enabled = r.enabled !== false;
  return out;
}

// ---------------------------------------------------------------------------
// Open / close / reopen / reorder
// ---------------------------------------------------------------------------

/** Open a session as the rightmost tab. Idempotent; no-op for empty ids. */
export function openTab(slice: TabSlice, sessionID: string | null | undefined): TabSlice {
  if (!sessionID || slice.open.includes(sessionID)) return slice;
  return { ...slice, open: [...slice.open, sessionID] };
}

/** Close one tab, pushing it onto the reopen stack (capped, newest last). */
export function closeTab(slice: TabSlice, sessionID: string): TabSlice {
  const index = slice.open.indexOf(sessionID);
  if (index === -1) return slice;
  const open = slice.open.filter((id) => id !== sessionID);
  const closed = [...slice.closed, { sessionID, index }].slice(-TABS_CLOSED_MAX);
  return { ...slice, open, closed };
}

/** Close every tab except `keep` (leftmost slot). Falls back to close-all. */
export function closeOtherTabs(slice: TabSlice, keep: string): TabSlice {
  if (!slice.open.includes(keep)) return closeAllTabs(slice);
  const dropped = slice.open
    .map((sessionID, index) => ({ sessionID, index }))
    .filter((t) => t.sessionID !== keep);
  const closed = [...slice.closed, ...dropped].slice(-TABS_CLOSED_MAX);
  return { ...slice, open: [keep], closed };
}

/** Close every tab. */
export function closeAllTabs(slice: TabSlice): TabSlice {
  if (slice.open.length === 0) return slice;
  const dropped = slice.open.map((sessionID, index) => ({ sessionID, index }));
  const closed = [...slice.closed, ...dropped].slice(-TABS_CLOSED_MAX);
  return { ...slice, open: [], closed };
}

/**
 * Reopen the most recently closed tab at its recorded position. Returns the
 * new slice plus the id that came back (null when the stack is empty).
 */
export function reopenTab(slice: TabSlice): { slice: TabSlice; sessionID: string | null } {
  const last = slice.closed[slice.closed.length - 1];
  if (!last) return { slice, sessionID: null };
  const closed = slice.closed.slice(0, -1);
  const without = slice.open.filter((id) => id !== last.sessionID);
  const at = Math.max(0, Math.min(last.index, without.length));
  const open = [...without.slice(0, at), last.sessionID, ...without.slice(at)];
  return { slice: { ...slice, open, closed }, sessionID: last.sessionID };
}

/** Move the tab at `from` to index `to` (both in open-tab coordinates). */
export function moveTab(slice: TabSlice, from: number, to: number): TabSlice {
  const len = slice.open.length;
  if (!Number.isInteger(from) || from < 0 || from >= len) return slice;
  const clamped = Math.max(0, Math.min(to, len - 1));
  if (from === clamped) return slice;
  const open = slice.open.slice();
  const moved = open.splice(from, 1)[0];
  if (moved === undefined) return slice;
  open.splice(clamped, 0, moved);
  return { ...slice, open };
}

/** Move a named tab to index `to`. */
export function moveTabTo(slice: TabSlice, sessionID: string, to: number): TabSlice {
  const from = slice.open.indexOf(sessionID);
  return from === -1 ? slice : moveTab(slice, from, to);
}

/**
 * Drop tabs / closed entries / pins whose session no longer exists
 * (boot-time prune after the session list loads). Returns the same slice when
 * nothing changed, so store actions can compare by identity.
 */
export function pruneTabSlice(slice: TabSlice, keep: (sessionID: string) => boolean): TabSlice {
  const open = slice.open.filter(keep);
  const closed = slice.closed.filter((c) => keep(c.sessionID));
  const pins = slice.pins.filter(keep);
  if (
    open.length === slice.open.length &&
    closed.length === slice.closed.length &&
    pins.length === slice.pins.length
  ) {
    return slice;
  }
  return { ...slice, open, closed, pins };
}

// ---------------------------------------------------------------------------
// Navigation math — session.tab.next/previous/next_unread/previous_unread/select.N
// ---------------------------------------------------------------------------

export function tabIndex(slice: TabSlice, sessionID: string | null | undefined): number {
  return sessionID ? slice.open.indexOf(sessionID) : -1;
}

/** `session.tab.select.N` — the id in the 1-based slot N (1..10), or null. */
export function tabAt(slice: TabSlice, n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > TAB_SELECT_MAX) return null;
  return slice.open[n - 1] ?? null;
}

/**
 * Step `dir` tabs from `current`, wrapping. A `current` that is not open (or
 * null) enters the list from the appropriate end. Null when there are no tabs.
 */
export function steppedTab(
  slice: TabSlice,
  current: string | null | undefined,
  dir: 1 | -1,
): string | null {
  const len = slice.open.length;
  if (len === 0) return null;
  const idx = current ? slice.open.indexOf(current) : -1;
  // dir>0 with an unknown current starts before the first slot; dir<0 starts
  // after the last, so the first step lands on a real tab (never off the end).
  const start = idx === -1 ? (dir > 0 ? -1 : 0) : idx;
  const next = (((start + dir) % len) + len) % len;
  return slice.open[next] ?? null;
}

export function nextTab(slice: TabSlice, current: string | null | undefined): string | null {
  return steppedTab(slice, current, 1);
}

export function previousTab(slice: TabSlice, current: string | null | undefined): string | null {
  return steppedTab(slice, current, -1);
}

/**
 * The next/previous tab satisfying `isUnread`, wrapping, excluding the current
 * slot. Null when nothing qualifies (so the binding can no-op rather than jump
 * somewhere arbitrary).
 */
export function adjacentUnreadTab(
  slice: TabSlice,
  current: string | null | undefined,
  isUnread: (sessionID: string) => boolean,
  dir: 1 | -1,
): string | null {
  const len = slice.open.length;
  if (len === 0) return null;
  const idx = current ? slice.open.indexOf(current) : -1;
  const start = idx === -1 ? (dir > 0 ? -1 : 0) : idx;
  for (let step = 1; step < len; step++) {
    const at = ((((start + dir * step) % len) + len) % len);
    const id = slice.open[at];
    if (id !== undefined && isUnread(id)) return id;
  }
  return null;
}

export function nextUnreadTab(
  slice: TabSlice,
  current: string | null | undefined,
  isUnread: (sessionID: string) => boolean,
): string | null {
  return adjacentUnreadTab(slice, current, isUnread, 1);
}

export function previousUnreadTab(
  slice: TabSlice,
  current: string | null | undefined,
  isUnread: (sessionID: string) => boolean,
): string | null {
  return adjacentUnreadTab(slice, current, isUnread, -1);
}

// ---------------------------------------------------------------------------
// Pins / quick slots — session.quick_switch.1..9 + session.pin.toggle
// ---------------------------------------------------------------------------

export function isPinned(slice: TabSlice, sessionID: string | null | undefined): boolean {
  return !!sessionID && slice.pins.includes(sessionID);
}

/** `session.pin.toggle`: add to the first free slot or remove. No-op when full. */
export function togglePin(slice: TabSlice, sessionID: string | null | undefined): TabSlice {
  if (!sessionID) return slice;
  if (slice.pins.includes(sessionID)) {
    return { ...slice, pins: slice.pins.filter((id) => id !== sessionID) };
  }
  if (slice.pins.length >= QUICK_SLOT_MAX) return slice;
  return { ...slice, pins: [...slice.pins, sessionID] };
}

export function unpin(slice: TabSlice, sessionID: string): TabSlice {
  if (!slice.pins.includes(sessionID)) return slice;
  return { ...slice, pins: slice.pins.filter((id) => id !== sessionID) };
}

/** Slot-number → id, as a fixed 9-cell array (null for empty slots). */
export function quickSlots(slice: TabSlice): (string | null)[] {
  const out: (string | null)[] = [];
  for (let i = 0; i < QUICK_SLOT_MAX; i++) out.push(slice.pins[i] ?? null);
  return out;
}

/** 1-based quick-slot number for a pinned session, or null. */
export function quickSlotNumber(slice: TabSlice, sessionID: string | null | undefined): number | null {
  const i = sessionID ? slice.pins.indexOf(sessionID) : -1;
  return i === -1 ? null : i + 1;
}

/** `session.quick_switch.N` — the pinned id in slot N (1..9), or null. */
export function pinnedSessionAt(slice: TabSlice, n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > QUICK_SLOT_MAX) return null;
  return slice.pins[n - 1] ?? null;
}

/**
 * Select-by-number with the §9.2 precedence: when tabs are enabled, N is
 * `session.tab.select.N`; when disabled, N is `session.quick_switch.N`. One
 * dispatcher so the two command ids can share a key without a second gate.
 */
export function numberedSwitchTarget(slice: TabSlice, n: number): string | null {
  return slice.enabled ? tabAt(slice, n) : pinnedSessionAt(slice, n);
}

// ---------------------------------------------------------------------------
// Per-tab status derivation
// ---------------------------------------------------------------------------

/** Everything the rail needs to choose a tab's indicator, as plain booleans. */
export interface TabSignals {
  /** The session (or one of its subagents) is producing. */
  running?: boolean;
  /** A send is parked behind the current turn (`state.queued`). */
  queued?: boolean;
  /** A permission request is waiting on a human (`!`). */
  permission?: boolean;
  /** A question / question-form is waiting on a human (`?`). */
  question?: boolean;
  /** A non-question form is waiting on a human (`?`, same slot). */
  form?: boolean;
  /** The last run ended in error (error colour). */
  error?: boolean;
  /** Output the user has not seen since last opening it (unread dot). */
  unread?: boolean;
}

export interface TabIndicators {
  /** Spinner while busy (running or queued). */
  busy: boolean;
  /** `!` — a permission is pending. */
  permission: boolean;
  /** `?` — a question/form wants input. */
  question: boolean;
  /** Error colour. */
  error: boolean;
  /** Unread dot (only while idle — a running tab is already flagged busy). */
  unread: boolean;
  /** Completion pulse — an idle, unread, unblocked tab that just produced. */
  pulse: boolean;
  /** Attention glow — the tab wants a human (permission / question / pulse). */
  attention: boolean;
}

/** Derive the full indicator set from the session's signals (pure). */
export function tabIndicators(signals: TabSignals): TabIndicators {
  const busy = !!signals.running || !!signals.queued;
  const permission = !!signals.permission;
  const question = !!signals.question || !!signals.form;
  const error = !!signals.error;
  // A busy tab shows the spinner, not an unread dot — the dot means "idle and
  // you have not looked yet", which is also what the completion pulse marks.
  const unread = !!signals.unread && !busy;
  const pulse = unread && !permission && !question && !error;
  const attention = permission || question || pulse;
  return { busy, permission, question, error, unread, pulse, attention };
}

/** A single status word, for compact mode and DOM anchoring. */
export type TabStatus = "error" | "permission" | "question" | "busy" | "unread" | "idle";

/** Highest-priority status (error > permission > question > busy > unread). */
export function tabStatus(ind: TabIndicators): TabStatus {
  if (ind.error) return "error";
  if (ind.permission) return "permission";
  if (ind.question) return "question";
  if (ind.busy) return "busy";
  if (ind.unread) return "unread";
  return "idle";
}

/** The one-letter label for compact one-letter mode. */
export function tabLetter(title: string | undefined, sessionID: string): string {
  const src = (title ?? "").trim() || sessionID;
  const ch = Array.from(src).find((c) => /[a-z0-9]/i.test(c));
  return (ch ?? "\u2022").toUpperCase();
}

// ---------------------------------------------------------------------------
// View models (what App/Sidebar hand to the rail via <Target> props)
// ---------------------------------------------------------------------------

/** One resolved tab: everything the rail renders, no lookups at render time. */
export interface TabRef {
  sessionID: string;
  title: string;
  /** 0-based position in the open window. */
  index: number;
  /** 1-based number cell (== index + 1, capped at TAB_SELECT_MAX). */
  number: number;
  current: boolean;
  indicators: TabIndicators;
  status: TabStatus;
  /** First alphanumeric character of the title, uppercased. */
  letter: string;
}

export interface TabRefSources {
  slice: TabSlice;
  current: string | null;
  titleOf: (sessionID: string) => string;
  signalsOf: (sessionID: string) => TabSignals;
}

/** Build the rail's view model from the slice + resolvers (pure). */
export function buildTabRefs(src: TabRefSources): TabRef[] {
  return src.slice.open.map((sessionID, index) => {
    const title = src.titleOf(sessionID);
    const indicators = tabIndicators(src.signalsOf(sessionID));
    return {
      sessionID,
      title,
      index,
      number: index + 1,
      current: sessionID === src.current,
      indicators,
      status: tabStatus(indicators),
      letter: tabLetter(title, sessionID),
    };
  });
}

/** One resolved pin (quick slot), for `sidebar.sessionPins` + the row gutter. */
export interface PinRef {
  /** 1-based quick-slot number (1..9). */
  slot: number;
  sessionID: string;
  title: string;
  current: boolean;
  indicators: TabIndicators;
  status: TabStatus;
  letter: string;
}

/** Build the pins view model from the slice + resolvers (pure). */
export function buildPinRefs(src: TabRefSources): PinRef[] {
  return src.slice.pins.map((sessionID, index) => {
    const title = src.titleOf(sessionID);
    const indicators = tabIndicators(src.signalsOf(sessionID));
    return {
      slot: index + 1,
      sessionID,
      title,
      current: sessionID === src.current,
      indicators,
      status: tabStatus(indicators),
      letter: tabLetter(title, sessionID),
    };
  });
}

// ---------------------------------------------------------------------------
// Command ids + proposed web bindings
// ---------------------------------------------------------------------------

/**
 * v2's session-tab / pins command ids (`app.tsx`). Kept as data so the store's
 * palette contributions, HelpDialog and the App hotkey table can share one
 * list rather than restating the strings (contract: these ids are v2's).
 */
export interface SessionTabBinding {
  id: string;
  /** Proposed WEB binding — v2's are terminal leader/chords (see parity §3.3). */
  keybind: string;
  title: string;
}

export const SESSION_TAB_BINDINGS: readonly SessionTabBinding[] = [
  { id: "session.tab.next", keybind: "alt+pagedown", title: "Next session tab" },
  { id: "session.tab.previous", keybind: "alt+pageup", title: "Previous session tab" },
  { id: "session.tab.next_unread", keybind: "alt+shift+pagedown", title: "Next unread tab" },
  { id: "session.tab.previous_unread", keybind: "alt+shift+pageup", title: "Previous unread tab" },
  { id: "session.tab.close", keybind: "alt+w", title: "Close session tab" },
  { id: "session.tab.reopen", keybind: "alt+shift+t", title: "Reopen closed tab" },
  { id: "session.pin.toggle", keybind: "ctrl+f", title: "Pin / unpin the focused session (session list)" },
] as const;

/** `session.tab.select.1..10` — the numbered tab ids, in order. */
export const TAB_SELECT_IDS: readonly string[] = Array.from(
  { length: TAB_SELECT_MAX },
  (_, i) => `session.tab.select.${i + 1}`,
);

/** `session.quick_switch.1..9` — the numbered quick-slot ids, in order. */
export const QUICK_SWITCH_IDS: readonly string[] = Array.from(
  { length: QUICK_SLOT_MAX },
  (_, i) => `session.quick_switch.${i + 1}`,
);
