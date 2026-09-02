/**
 * Central store: sessions, messages, live assistant state, permission and
 * form queues. Driven by the /api/event stream plus REST fetches.
 */

import { useRef, useSyncExternalStore } from "react";
import {
  api,
  type CompactDelivery,
  type ForkBoundary,
  type PromptDelivery,
  type PromptFile,
} from "./api/client";
import { connectEvents, sseStale, type V2Event } from "./api/events";
import { log } from "./lib/log";
import { registerPoller, startScheduler } from "./lib/scheduler";
import type {
  AssistantMessage,
  InboxInfo,
  MessageInfo,
  ModelRef,
  PermissionRequest,
  QuestionAnswer,
  QuestionInfo,
  QuestionRequest,
  SessionInfo,
  StructuredError,
  ToolContent,
  ToolPart,
  ToolState,
  FormInfo,
} from "./api/types";

// ---- pending request queue (permissions / forms / questions) ------------
//
// All three "the agent needs a human decision" surfaces share ONE popup,
// shown in arrival order no matter which session raised them. Entries are
// stamped with a client-side sequence number at insertion time — the engine
// gives no ordering across kinds, and refreshQueues() replaces whole arrays
// on boot/reconnect, so stamps are reused for known ids to keep order stable.

export interface QueuedPermission extends PermissionRequest {
  seq: number;
}
export interface QueuedForm extends FormInfo {
  seq: number;
}
/**
 * Native questions come from `question.asked` events (newer engines). On the
 * current engine they arrive as FORMS with metadata.kind === "question" —
 * those are projected into this shape by pendingRequests() with
 * channel:"form", so reply/reject route through the form endpoints.
 */
export interface QueuedQuestion extends QuestionRequest {
  seq: number;
  channel?: "native" | "form";
}

export type PendingRequest =
  | { kind: "permission"; req: QueuedPermission }
  | { kind: "form"; req: QueuedForm }
  | { kind: "question"; req: QueuedQuestion };

let requestSeq = 0;
const nextRequestSeq = () => ++requestSeq;

/**
 * When each form id was first seen — protects NEWBORN requests from the
 * create-race: the engine broadcasts `form.created` before its REST state
 * commits, so an immediate GET …/form/{id}/state can 404 transiently.
 * Treating that 404 as "resolved" killed freshly created panels within one
 * frame (seen live: show/hide in the same millisecond).
 */
const formFirstSeen = new Map<string, number>();
const NEWBORN_GRACE_MS = 60_000;

function noteFormSeen(ids: Iterable<string>) {
  const now = Date.now();
  for (const id of ids) if (!formFirstSeen.has(id)) formFirstSeen.set(id, now);
  // prune: only live ids matter
  if (formFirstSeen.size > 500) {
    for (const [id, t] of formFirstSeen) if (now - t > 10 * NEWBORN_GRACE_MS) formFirstSeen.delete(id);
  }
}

/**
 * Forms confirmed settled (answered/cancelled/reaped), with timestamps — a
 * tombstone so the engine's laggy global listing can't resurrect them (and
 * re-trigger a /state check every sweep) before the listing itself catches
 * up. Kept for NEWBORN_GRACE_MS, which comfortably exceeds the listing lag.
 */
const settledRecently = new Map<string, number>();

/** Stamp incoming requests, reusing the seq — and the exact OBJECT — of ids
 * we already track. Engine payloads for a pending id are immutable, so
 * identity reuse keeps pendingCache valid (no per-tick invalidation churn). */
function stampSeq<T extends { id: string }>(current: { id: string; seq: number }[], incoming: T[]): (T & { seq: number })[] {
  const known = new Map(current.map((r) => [r.id, r]));
  return incoming.map((r) => {
    const prev = known.get(r.id);
    return prev ? (prev as T & { seq: number }) : { ...r, seq: nextRequestSeq() };
  });
}

/** Engine encoding of one mid-task question, when delivered as a form. */
function isQuestionForm(form: FormInfo): boolean {
  return (form.metadata as { kind?: string } | undefined)?.kind === "question";
}

function questionFromForm(form: QueuedForm): QueuedQuestion {
  const meta = form.metadata as { tool?: QuestionRequest["tool"] } | undefined;
  return {
    id: form.id,
    sessionID: form.sessionID,
    seq: form.seq,
    channel: "form",
    tool: meta?.tool,
    questions: form.fields.map((f) => {
      const extra = f as { custom?: boolean };
      return {
        header: ("title" in f ? f.title : undefined) ?? f.key,
        question: ("description" in f ? f.description : undefined) ?? "",
        options: ("options" in f ? (f.options ?? []) : []).map((o) => ({
          label: o.label,
          value: o.value,
          description: o.description ?? "",
        })),
        // The engine encodes multiplicity as the FIELD TYPE (verified:
        // multi-choice questions are `multiselect` fields, single-choice and
        // free-text are `string`) — there is no `multiple` flag.
        multiple: "type" in f && f.type === "multiselect",
        custom: extra.custom === true,
      };
    }),
  };
}

/** Every unanswered permission/form/question across ALL sessions, FIFO. */
// Snapshot-stable: useStore selectors must not return fresh object graphs
// per call, or useSyncExternalStore re-render-loops (and the panel/chip
// die silently). Cached on the three source array identities — any change
// to any queue invalidates once.
let pendingCache: {
  permissions: QueuedPermission[];
  forms: QueuedForm[];
  questions: QueuedQuestion[];
  out: PendingRequest[];
} | null = null;

export function pendingRequests(s: State): PendingRequest[] {
  if (
    pendingCache &&
    pendingCache.permissions === s.permissions &&
    pendingCache.forms === s.forms &&
    pendingCache.questions === s.questions
  ) {
    return pendingCache.out;
  }
  const all: PendingRequest[] = [];
  for (const req of s.permissions) all.push({ kind: "permission", req });
  for (const req of s.questions) all.push({ kind: "question", req });
  for (const req of s.forms) {
    if (isQuestionForm(req)) all.push({ kind: "question", req: questionFromForm(req) });
    else all.push({ kind: "form", req });
  }
  const out = all.sort((a, b) => a.req.seq - b.req.seq);
  pendingCache = { permissions: s.permissions, forms: s.forms, questions: s.questions, out };
  return out;
}

/** Best human-readable name for any session (sidebar list or detail cache). */
export function sessionLabel(s: State, sessionID: string): string {
  if (isDraftSession(sessionID)) return "New session";
  return (
    s.sessions.find((x) => x.id === sessionID)?.title ??
    s.sessionDetails[sessionID]?.title ??
    `session ${sessionID.slice(0, 8)}…`
  );
}

// ---- live message model -------------------------------------------------

export interface LiveTool {
  id: string;
  name: string;
  inputText: string;
  input?: unknown;
  status: "streaming" | "running" | "completed" | "error";
  content?: ToolContent[];
  metadata?: Record<string, unknown>;
  error?: StructuredError;
  executed?: boolean;
  created?: number;
  ran?: number;
  completed?: number;
}

export type LiveContentPart =
  | { type: "text"; ordinal: number; text: string }
  | { type: "reasoning"; ordinal: number; text: string }
  | { type: "tool"; tool: LiveTool };

export interface LiveAssistant {
  /** Which session's pane owns this entry — every helper scopes by it. */
  sessionID: string;
  id: string;
  agent?: string;
  model?: ModelRef;
  content: LiveContentPart[];
  text: string;
  reasoning: string;
  tools: Map<string, LiveTool>;
  finish?: string;
  cost?: number;
  error?: StructuredError;
  started: number;
  completed?: number;
}

export type RunNoticeKind = "retry" | "error" | "interrupted" | "failed";

/** One transient run-problem row above the composer. */
export interface RunNotice {
  id: string;
  kind: RunNoticeKind;
  text: string;
  /** Epoch ms when the underlying event fired. */
  at: number;
}

/**
 * One message sent while its session was BUSY: admitted engine-side as a
 * durable inbox item but not yet delivered — shown in the QueueStrip above
 * the composer, never optimistically in the transcript. Rows resolve when
 * the engine delivers/cancels them (event + poll reconciliation below).
 */
export interface PendingSend {
  key: string;
  text: string;
  /** "sending" = POST in flight; "tracked" = admitted, inboxID known. */
  state: "sending" | "tracked";
  /** Engine inbox item id (`^msg_`) once admitted. */
  inboxID?: string;
  /** steer = joins the active run at the next step; queue = after this turn. */
  delivery?: PromptDelivery;
  /** Client epoch ms when the row was admitted — feeds delivered-detection. */
  admittedAt?: number;
}

/**
 * Split-view pane identity. Pane id "main" is the routed surface (its
 * session follows selectSession / the URL); every other pane pins ONE
 * session and stays interactive regardless of focus.
 */
export const MAIN_PANE = "main";
export const MAX_SPLITS = 3;

export interface SplitPane {
  id: string;
  sessionID: string | null;
}

export interface State {
  connected: boolean;
  serviceOK: boolean;
  sessions: SessionInfo[];
  sessionsCursor: string | null;
  activeIDs: string[];
  messages: Record<string, MessageInfo[]>;
  sessionDetails: Record<string, SessionInfo>;
  /**
   * Live streaming projections — one entry-set PER mounted session (each
   * carries `sessionID`). Every pane renders only its own entries; entries
   * for unmounted sessions are pruned/ignored.
   */
  live: LiveAssistant[];
  running: Record<string, boolean>;
  queued: Record<string, boolean>;
  permissions: QueuedPermission[];
  forms: QueuedForm[];
  questions: QueuedQuestion[];
  currentSessionID: string | null;
  /**
   * Split view: panes[0] is ALWAYS the routed main surface; entries 1..n are
   * sessions pinned beside it (VS Code "split editor"). Every pane renders a
   * fully interactive Conversation+Composer; sends and SSE are per-session,
   * so background panes keep running.
   */
  panes: SplitPane[];
  /** Which pane owns global chrome (Esc interrupt, type-anywhere, runs panel). */
  focusedPane: string;
  /** The "pick a session for a new split" dialog. */
  splitPickerOpen: boolean;
  /**
   * Incremented whenever any surface asks to open/focus the shell panel;
   * lets distant components (e.g. composer chips) trigger it without
   * prop plumbing. Additive signal only — never read for logic.
   */
  shellPanelTick: number;
  /**
   * One-shot open requests for surfaces whose open state lives elsewhere
   * (pickers, file explorer, runs dialog, help). Components subscribe to
   * their counter and open themselves when it increments.
   */
  uiSignals: UiSignals;
  /** Text restored by /undo — the composer consumes it once and clears it. */
  revertPrompt: string | null;
  runsPanelOpen: boolean;
  /**
   * Last RunsPanel cursor (tab + highlighted rows) — written through by the
   * panel on every change and restored on reopen when it still points at
   * reality (subagent exists / index within bounds). Null until first open.
   */
  runsSelection: RunsSelection | null;
  /**
   * Subagent pages open read-only: the composer stays hidden behind an
   * "Enter to message" hint until Enter reveals it. Reset on every session
   * switch, so arriving on a subagent page is always gated first.
   */
  subagentComposerOpen: boolean;
  /**
   * Client-only draft session (id === DRAFT_SESSION_ID). Nothing exists
   * server-side until the first message is sent — clicking New again simply
   * re-binds the draft to another workspace, navigating away discards it.
   */
  draftWorkspace: string | null;
  /**
   * Dirty agent/model selections for the CURRENT session: applied locally
   * immediately, committed to the engine only when the next message is sent
   * (and silently dropped if switched back first). Never persists an
   * "Agent/Model switched …" note for a change that never ran.
   */
  pendingAgent: string | null;
  pendingModel: ModelRef | null;
  /** Last send failure per session — rendered above the composer. */
  sendErrors: Record<string, StructuredError>;
  /**
   * Undelivered busy-sends per session (STEER vs QUEUE strip). Entries are
   * admitted engine-side inbox items awaiting delivery; reconciled by the
   * session.inbox.* events and the poll fallback.
   */
  pending: Record<string, PendingSend[]>;
  /**
   * Transient run-problem notes per session (provider retries, failures,
   * interrupts), newest last, capped — rendered above the composer.
   */
  runNotices: Record<string, RunNotice[]>;
  /** Workspace targeted by the sidebar for the NEXT new session (highlight). */
  pendingWorkspace: string | null;
  /** Sidebar search: scroll to this message after selecting its session. */
  highlightMessageID: string | null;
  highlightSessionID: string | null;
  /** The case-insensitive substring that was matched in the highlighted message. */
  highlightQuery: string | null;
  /** Incremented on each highlight navigation so re-clicks on the same message re-fire. */
  highlightTick: number;
  /** Pending edit — staged on click, committed only when the user sends. */
  pendingEdit: { sessionID: string; messageID: string; originalText: string } | null;
  /**
   * Revert (undo/edit) view cut per session: messageID = transcript is cut
   * AT that message (exclusive); null = known-cleared; absent = unknown —
   * only then may a session-detail fetch adopt the engine's staged state.
   * Owned by `session.revert.*` events and local mirrors, NEVER by refetch
   * races (a late staged-state fetch must not resurrect a cut we cleared).
   */
  revertMarkers: Record<string, string | null>;
  /**
   * Two-step interrupt arming: the first Esc sets this (the composer swaps
   * its status line for a yellow confirm hint); a second Esc inside the
   * window aborts, and the flag self-clears on timeout.
   */
  interruptArmed: boolean;
}

/**
 * Sentinel id for the optimistic not-yet-created session. It NEVER hits the
 * wire: every api.* call site must materialize the draft into a real session
 * first (see materializeDraft).
 */
export const DRAFT_SESSION_ID = "__draft__";

export function isDraftSession(id: string | null | undefined): boolean {
  return id === DRAFT_SESSION_ID;
}

export interface UiSignals {
  models: number;
  agents: number;
  themes: number;
  explorer: number;
  runsDialog: number;
  help: number;
  variants: number;
}

const initialState: State = {
  connected: false,
  serviceOK: false,
  sessions: [],
  sessionsCursor: null,
  activeIDs: [],
  messages: {},
  sessionDetails: {},
  live: [],
  running: {},
  queued: {},
  permissions: [],
  forms: [],
  questions: [],
  currentSessionID: null,
  panes: [{ id: MAIN_PANE, sessionID: null }],
  focusedPane: MAIN_PANE,
  splitPickerOpen: false,
  shellPanelTick: 0,
  uiSignals: { models: 0, agents: 0, themes: 0, explorer: 0, runsDialog: 0, help: 0, variants: 0 },
  revertPrompt: null,
  runsPanelOpen: false,
  runsSelection: null,
  subagentComposerOpen: false,
  draftWorkspace: null,
  pendingAgent: null,
  pendingModel: null,
  sendErrors: {},
  pending: {},
  runNotices: {},
  pendingWorkspace: null,
  interruptArmed: false,
  highlightMessageID: null,
  highlightSessionID: null,
  highlightQuery: null,
  highlightTick: 0,
  pendingEdit: null,
  revertMarkers: {},
};

let state: State = initialState;
const listeners = new Set<() => void>();
let stateBatchDepth = 0;
let stateBatchPending = false;

function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  if (stateBatchDepth > 0) {
    stateBatchPending = true;
    return;
  }
  emit();
}
function emit() {
  for (const fn of listeners) fn();
}

function batchState(fn: () => void) {
  stateBatchDepth += 1;
  try {
    fn();
  } finally {
    stateBatchDepth -= 1;
    if (stateBatchDepth === 0 && stateBatchPending) {
      stateBatchPending = false;
      emit();
    }
  }
}

/**
 * useSyncExternalStore requires getSnapshot to return a referentially
 * stable value; derived selectors (e.g. `s.messages[id] ?? []`) would
 * otherwise produce a new reference every call and trigger an infinite
 * re-render loop. We cache the last selected value per hook instance and
 * return it when the new value is shallow-equal.
 */
function isShallowEqual(a: unknown, b: unknown): boolean {
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

export function useStore<T>(select: (s: State) => T): T {
  const cached = useRef<{ value: T } | null>(null);
  const getSnapshot = (): T => {
    const value = select(state);
    if (cached.current && isShallowEqual(cached.current.value, value)) return cached.current.value;
    cached.current = { value };
    return value;
  };
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot,
  );
}

export function getState(): State {
  return state;
}

export const NEW_SESSION_HREF = "/new-session";

export function sessionHref(sessionID: string): string {
  return `/session/${encodeURIComponent(sessionID)}`;
}

function sessionIDFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/session\/([^/]+)\/?$/);
  if (!match) return null;
  const encoded = match[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function isNewSessionRoute(): boolean {
  return typeof window !== "undefined" && window.location.pathname === NEW_SESSION_HREF;
}

function updateSessionHistory(sessionID: string | null, mode: "push" | "replace") {
  if (typeof window === "undefined") return;
  // The draft session lives at /new-session — it IS the new-session route.
  const next =
    sessionID === DRAFT_SESSION_ID ? NEW_SESSION_HREF : sessionID ? sessionHref(sessionID) : "/";
  if (window.location.pathname === next && !window.location.search && !window.location.hash) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", next);
}

// ---- refresh helpers ----------------------------------------------------

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRefreshSessions() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshSessions(), 400);
}

const SESSION_PAGE = 100;

// ---- engine "active" lag guards ------------------------------------------
//
// The engine's GET /session/active map and inbox listings LAG reality by tens
// of seconds (verified against the live service: a finished session stays
// "active", a delivered inbox item stays listed). Trusting the map blindly
// resurrects cleared `running` flags — the stuck "Working…" after a run
// ends — and keeps dead sessions in the ActivityStrip. Two guards:
//
// - `lastRunEnd`: when WE just ended a run (event/interrupt), never let the
//   laggy map re-add the flag for a grace period.
// - `lastLiveSignal`: when the map says INACTIVE and no live event has
//   arrived for a while, clear the flag — the event that would have cleared
//   it was missed (this is the "stuck running until refresh" bug).

const ACTIVE_READD_SUPPRESS_MS = 30_000;
const RUNNING_WATCHDOG_MS = 15_000;
const QUEUED_WATCHDOG_MS = 45_000;

const lastRunEnd = new Map<string, number>();
const lastLiveSignal = new Map<string, number>();

function noteRunEnd(sessionID: string) {
  if (sessionID) lastRunEnd.set(sessionID, Date.now());
}

/** Last time an SSE live event (step/text/tool/execution) hit this session. */
export function lastLiveSignalAt(sessionID: string): number {
  return lastLiveSignal.get(sessionID) ?? 0;
}

export async function refreshSessions() {
  try {
    const res = await api.listSessions({ limit: Math.max(SESSION_PAGE, state.sessions.length + 1) });
    const active = await api.activeSessions();
    const activeKeys = new Set(Object.keys(active.data));
    const now = Date.now();
    const running = { ...state.running };
    // The active map is the only signal that a session STARTED elsewhere
    // (another tab, engine-side) — keep adding it, but never over a local
    // end we just recorded: the map is laggy, our end is not.
    const newlyActive: string[] = [];
    for (const id of activeKeys) {
      if (running[id]) continue;
      if (now - (lastRunEnd.get(id) ?? 0) < ACTIVE_READD_SUPPRESS_MS) continue;
      running[id] = true;
      newlyActive.push(id);
    }
    for (const id of newlyActive) ensureSessionWait(id);
    // Watchdog: the engine says idle AND no live event for a fair window →
    // the flag is stale (its clearing event was missed). Clear it.
    for (const [sid, on] of Object.entries(running)) {
      if (!on || activeKeys.has(sid)) continue;
      if (now - lastLiveSignalAt(sid) < RUNNING_WATCHDOG_MS) continue;
      delete running[sid];
    }
    const queued = { ...state.queued };
    for (const [sid, on] of Object.entries(queued)) {
      if (!on || activeKeys.has(sid) || running[sid]) continue;
      if (now - lastLiveSignalAt(sid) < QUEUED_WATCHDOG_MS) continue;
      delete queued[sid];
    }
    const sessions = [...res.data].sort((a, b) => b.time.updated - a.time.updated);
    // Compare-before-set: this sweep runs every 10-20s forever, and replacing
    // the sessions array (or the flags) unconditionally re-rendered the
    // Sidebar even when nothing changed — the visible "refresh every few
    // seconds" churn. Only touch what actually moved.
    const sessionsChanged =
      state.sessions.length !== sessions.length ||
      state.sessions.some((s, i) => {
        const n = sessions[i];
        if (!n) return true;
        return n.id !== s.id || n.time.updated !== s.time.updated || n.title !== s.title;
      });
    const flagsEqual = (a: Record<string, boolean>, b: Record<string, boolean>) => {
      const ka = Object.keys(a).filter((k) => a[k]);
      const kb = Object.keys(b).filter((k) => b[k]);
      return ka.length === kb.length && ka.every((k) => b[k]);
    };
    const activeIDs = [...activeKeys];
    const activeChanged =
      state.activeIDs.length !== activeIDs.length ||
      state.activeIDs.some((id, i) => id !== activeIDs[i]);
    if (!sessionsChanged && !activeChanged && flagsEqual(state.running, running) && flagsEqual(state.queued, queued)) {
      return;
    }
    setState({
      ...(sessionsChanged ? { sessions, sessionsCursor: res.cursor.next } : {}),
      ...(activeChanged ? { activeIDs } : {}),
      ...(!flagsEqual(state.running, running) ? { running } : {}),
      ...(!flagsEqual(state.queued, queued) ? { queued } : {}),
    });
  } catch (err) {
    console.warn("refreshSessions failed:", err);
  }
}

export async function loadMoreSessions() {
  try {
    const res = await api.listSessions({ limit: SESSION_PAGE, cursor: state.sessionsCursor });
    const merged = new Map<string, SessionInfo>();
    for (const s of state.sessions) merged.set(s.id, s);
    for (const s of res.data) merged.set(s.id, s);
    const sessions = [...merged.values()].sort((a, b) => b.time.updated - a.time.updated);
    setState({ sessions, sessionsCursor: res.cursor.next });
  } catch (err) {
    console.warn("loadMoreSessions failed:", err);
  }
}

async function refreshQueues() {
  // Independent fetches: one failing endpoint must never blank the others
  // (a single rejected Promise.all here used to silently kill ALL queue
  // loads — the "request popup never shows" bug).
  const mounted = new Set(
    state.panes.map((p) => p.sessionID).filter((sid): sid is string => !!sid),
  );
  const [perms, forms, ...perSession] = await Promise.allSettled([
    api.pendingPermissions(),
    api.pendingForms(),
    ...[...mounted].map((sid) => api.sessionForms(sid)),
  ]);

  /**
   * Merge a listing into a queue WITHOUT clobbering concurrent event writes.
   * refreshQueues awaits the network; `form.created` can land mid-flight.
   * Building the next array from a pre-await snapshot and setState-ing it
   * later ERASED those events — a freshly created panel mounted and unmounted
   * within one frame (seen live: show/hide in the same millisecond). So the
   * merge runs at APPLY time against live state, and only two facts cross
   * the async gap: raw listing data + settled ids. No awaits may sit between
   * reading `state` and calling setState inside here.
   */
  function unionById<T extends { id: string }>(current: (T & { seq: number })[], listed: T[]): (T & { seq: number })[] {
    const merged = new Map(stampSeq(current, listed).map((r) => [r.id, r]));
    for (const r of current) if (!merged.has(r.id)) merged.set(r.id, r);
    return [...merged.values()];
  }

  if (perms.status === "fulfilled") {
    // Listings lag behind events on BOTH sides (verified against the live
    // service). Union by id — removal is event-driven (permission.replied).
    const listed = perms.value.data;
    setState({ permissions: unionById(state.permissions, listed) });
  } else console.warn("refreshQueues permissions failed:", perms.reason);

  if (forms.status === "fulfilled") {
    // The GLOBAL form listing is an unreliable hint for question-kind forms:
    // it can omit a pending one indefinitely under load (measured: absent for
    // 45s straight while the panel was on screen). Per-session listings are
    // fresh — so every MOUNTED session is also polled directly and the views
    // are unioned by id. Global still covers unmounted sessions' chips.
    const byId = new Map<string, FormInfo>();
    const push = (f: FormInfo) => {
      if (!byId.has(f.id)) byId.set(f.id, f);
    };
    forms.value.data.forEach(push);
    for (const r of perSession) {
      if (r.status === "fulfilled") r.value.data.forEach(push);
      else console.warn("refreshQueues session forms failed:", r.reason);
    }
    const listed = [...byId.values()];

    // The listing(s) are only hints — /state is authoritative per form. Settle
    // verdicts cross the await gap as an id set and are applied synchronously
    // below (no awaits between reading state and setState).
    const current = state.forms;
    noteFormSeen([...current.map((f) => f.id), ...listed.map((f) => f.id)]);
    // §8.3: /state-check ONLY forms we already track (the displayed set).
    // Checking current ∪ listed re-verified every form the listing returns
    // every sweep — an N+1 that also fed itself: a laggy listing keeps
    // returning an ANSWERED form for tens of seconds, the union re-added it
    // after the check removed it, and the loop never converged. Newly listed
    // forms skip this sweep's check (they enter state.forms and are checked
    // next sweep; NEWBORN_GRACE_MS already tolerates their create-race 404).
    const checkIds = new Set(current.map((f) => f.id));
    const settled = new Set<string>();
    await Promise.all(
      [...checkIds].map(async (id) => {
        const f =
          state.forms.find((x) => x.id === id) ?? byId.get(id);
        if (!f) return;
        try {
          const st = await api.formState(f.sessionID, id);
          // Affirmative answered/cancelled → gone, regardless of age.
          if ((st.data?.status ?? "pending") !== "pending") settled.add(id);
        } catch (err) {
          // 404 usually means resolved-and-reaped server-side — but right
          // after creation it can also be the engine's commit lag. Only
          // trust it once the request has been around a while.
          const msg = err instanceof Error ? err.message : String(err);
          const first = formFirstSeen.get(id) ?? Date.now();
          if (msg.includes("404") && Date.now() - first > NEWBORN_GRACE_MS) settled.add(id);
        }
      }),
    );
    // Tombstone what we just settled so the laggy listing can't resurrect it
    // (and re-trigger checks) until the listing itself catches up.
    const now = Date.now();
    for (const id of settled) settledRecently.set(id, now);
    if (settledRecently.size > 500) {
      for (const [id, at] of settledRecently) if (now - at > NEWBORN_GRACE_MS) settledRecently.delete(id);
    }
    const stillListed = listed.filter((f) => {
      const at = settledRecently.get(f.id);
      return at === undefined || Date.now() - at > NEWBORN_GRACE_MS;
    });
    log("queue", `refresh forms=${current.length} listed=${listed.length} settled=${settled.size}`);
    setState({
      forms: unionById(state.forms, stillListed).filter((f) => !settled.has(f.id)),
    });
  } else console.warn("refreshQueues forms failed:", forms.reason);
  // NOTE: questions are NOT fetched here — this engine version exposes no
  // question REST routes; they arrive as `form.created` events whose
  // metadata.kind is "question" (projected in pendingRequests() below), and
  // native `question.asked` events feed state.questions directly.
}

export async function loadMessages(sessionID: string) {
  if (isDraftSession(sessionID)) return; // nothing exists server-side yet
  const request = beginMessageRequest(sessionID);
  // Fetch up to 200 per page and follow cursor to get full history (up to ~500) so the rail / search see all user messages.
  let all: typeof api.messages extends (a: string, b: number) => Promise<infer R> ? R extends { data: infer D } ? D : never : never = [] as never;
  let cursor: string | null | undefined = undefined;
  let pages = 0;
  try {
    do {
      const res: { data: MessageInfo[]; cursor?: { next?: string | null; previous?: string | null } } = cursor
        ? await api.messagesWithCursor(sessionID, 200, cursor)
        : await api.messages(sessionID, 200);
      if (messageRequests.get(sessionID) !== request) return;
      const chunk = res.data as MessageInfo[];
      // api.messages returns desc order; accumulate then reverse once at end.
      (all as MessageInfo[]).push(...chunk);
      cursor = (res as { cursor?: { next?: string | null } }).cursor?.next;
      pages++;
      if (chunk.length < 200) break;
    } while (cursor && pages < 5);
  } catch (err) {
    if ((all as MessageInfo[]).length === 0) {
      console.warn("loadMessages failed:", err);
      return;
    }
    console.warn("loadMessages partial failure, using", (all as MessageInfo[]).length, "messages:", err);
  }
  if (messageRequests.get(sessionID) !== request) return;
  const history = [...(all as MessageInfo[])].reverse();
  log("load", `messages ${sessionID}: ${history.length} (${pages} pages)`);
  applyFetchedMessages(sessionID, history);
}

// ---- live message helpers ----------------------------------------------

const messageRequests = new Map<string, number>();

function beginMessageRequest(sessionID: string): number {
  const request = (messageRequests.get(sessionID) ?? 0) + 1;
  messageRequests.set(sessionID, request);
  return request;
}

function isUnfinishedAssistant(message: MessageInfo | undefined): boolean {
  return message?.type === "assistant" && message.time.completed === undefined;
}

// ---- per-pane live scoping ----------------------------------------------
//
// Live projections are PER SESSION: every session mounted in a pane (main
// plus splits) streams simultaneously and renders ONLY its own entries.
// Helpers below filter `state.live` by LiveAssistant.sessionID; events for
// unmounted sessions are ignored outright (bounded memory).

/** Is this session mounted in ANY pane (main included)? */
function isPaneSession(sid: string): boolean {
  return state.panes.some((p) => p.sessionID === sid);
}

/** This session's live projection entries. */
function liveForSession(sessionID: string): LiveAssistant[] {
  return state.live.filter((a) => a.sessionID === sessionID);
}

/**
 * Whether to track live-stream events for this session. Pane membership is
 * not sufficient on initial load: state.panes[0] is {id:"main",sessionID:null}
 * until selectSession's sync setState runs, and SSE may connect in the same
 * microtask window. Treating currentSessionID (and any already-tracked live)
 * as live ensures the first text deltas are not dropped (streaming ASAP fix).
 */
function shouldTrackLive(sid: string): boolean {
  if (!sid) return false;
  if (isPaneSession(sid)) return true;
  if (sid === state.currentSessionID) return true;
  if (liveForSession(sid).length > 0) return true;
  if (!!state.running[sid]) return true;
  if (!!state.queued[sid]) return true;
  if (state.activeIDs.includes(sid)) return true;
  return false;
}

/**
 * Drop live entries whose session is not in the GIVEN pane layout. Callers
 * rebind panes in the same setState that prunes — compute against the NEXT
 * layout, never the current one, or the outgoing main session's stream
 * would survive as a ghost.
 */
function pruneLiveForPanes(panes: SplitPane[]): LiveAssistant[] {
  const mounted = new Set(panes.map((p) => p.sessionID));
  return state.live.filter(
    (a) => mounted.has(a.sessionID) || !!state.running[a.sessionID] || !!state.queued[a.sessionID] || state.activeIDs.includes(a.sessionID),
  );
}

// ---- live persistence across reloads ------------------------------------
//
// History's assistant.text stays "" for the entire stream (verified: 0 until
// execution.succeeded), so a hard refresh mid-stream loses the first half.
// SSE is volatile with no replay. The only fix is client-side persistence:
// every live mutation snapshots the session's projection to localStorage, and
// a reload restores it before history seeding. Subsequent deltas append via
// appendStreamDelta's overlap handling.

const LIVE_STORAGE_PREFIX = "webui.live.";

function liveStorageKey(sessionID: string): string {
  return `${LIVE_STORAGE_PREFIX}${sessionID}`;
}

function persistLiveForSession(sessionID: string) {
  if (!sessionID || isDraftSession(sessionID)) return;
  try {
    if (typeof localStorage === "undefined") return;
    const entries = liveForSession(sessionID);
    if (entries.length === 0) {
      localStorage.removeItem(liveStorageKey(sessionID));
      return;
    }
    const serialized = entries.map((a) => ({
      id: a.id,
      sessionID: a.sessionID,
      agent: a.agent,
      model: a.model,
      started: a.started,
      completed: a.completed,
      finish: a.finish,
      cost: a.cost,
      error: a.error,
      content: a.content.map((p) =>
        p.type === "tool"
          ? {
              type: "tool" as const,
              tool: {
                id: p.tool.id,
                name: p.tool.name,
                inputText: p.tool.inputText,
                input: p.tool.input,
                status: p.tool.status,
                content: p.tool.content,
                metadata: p.tool.metadata,
                error: p.tool.error,
                executed: p.tool.executed,
                created: p.tool.created,
                ran: p.tool.ran,
                completed: p.tool.completed,
              },
            }
          : { type: p.type as "text" | "reasoning", ordinal: p.ordinal, text: p.text },
      ),
    }));
    localStorage.setItem(liveStorageKey(sessionID), JSON.stringify(serialized));
  } catch {
    /* private mode / quota */
  }
}

function clearPersistedLive(sessionID: string) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(liveStorageKey(sessionID));
  } catch {
    /* ignore */
  }
}

function tryRestoreLiveFromStorage(sessionID: string): boolean {
  if (!sessionID || isDraftSession(sessionID)) return false;
  if (liveForSession(sessionID).length > 0) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(liveStorageKey(sessionID));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    const restored: LiveAssistant[] = [];
    for (const entry of parsed as Record<string, unknown>[]) {
      if (!entry || typeof entry.id !== "string" || typeof entry.sessionID !== "string") continue;
      if (entry.sessionID !== sessionID) continue;
      const rawContent = Array.isArray(entry.content) ? (entry.content as unknown[]) : [];
      const content: LiveContentPart[] = [];
      const tools = new Map<string, LiveTool>();
      for (const p of rawContent as Record<string, unknown>[]) {
        if (!p || typeof p.type !== "string") continue;
        if (p.type === "tool" && p.tool && typeof (p.tool as Record<string, unknown>).id === "string") {
          const t = p.tool as Record<string, unknown>;
          const tool: LiveTool = {
            id: t.id as string,
            name: (t.name as string) ?? "tool",
            inputText: (t.inputText as string) ?? "",
            input: t.input,
            status: (t.status as LiveTool["status"]) ?? "streaming",
            content: t.content as ToolContent[] | undefined,
            metadata: t.metadata as Record<string, unknown> | undefined,
            error: t.error as StructuredError | undefined,
            executed: t.executed as boolean | undefined,
            created: t.created as number | undefined,
            ran: t.ran as number | undefined,
            completed: t.completed as number | undefined,
          };
          tools.set(tool.id, tool);
          content.push({ type: "tool", tool });
        } else if (
          (p.type === "text" || p.type === "reasoning") &&
          typeof p.ordinal === "number" &&
          typeof p.text === "string"
        ) {
          content.push({ type: p.type as "text" | "reasoning", ordinal: p.ordinal as number, text: p.text as string });
        }
      }
      const base: LiveAssistant = {
        sessionID: entry.sessionID as string,
        id: entry.id as string,
        agent: entry.agent as string | undefined,
        model: entry.model as ModelRef | undefined,
        content,
        text: "",
        reasoning: "",
        tools,
        finish: entry.finish as string | undefined,
        cost: entry.cost as number | undefined,
        error: entry.error as StructuredError | undefined,
        started: typeof entry.started === "number" ? (entry.started as number) : Date.now(),
        completed: entry.completed as number | undefined,
      };
      restored.push(withLiveContent(base, content));
    }
    if (restored.length === 0) return false;
    setState({ live: [...state.live, ...restored] });
    log("load", `restored ${restored.length} live assistant(s) for ${sessionID} from localStorage`);
    return true;
  } catch {
    return false;
  }
}

function liveContentSummary(content: LiveContentPart[]) {
  return {
    text: content
      .filter((part): part is Extract<LiveContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join(""),
    reasoning: content
      .filter((part): part is Extract<LiveContentPart, { type: "reasoning" }> => part.type === "reasoning")
      .map((part) => part.text)
      .join(""),
    tools: new Map(
      content
        .filter((part): part is Extract<LiveContentPart, { type: "tool" }> => part.type === "tool")
        .map((part) => [part.tool.id, part.tool]),
    ),
  };
}

function withLiveContent(assistant: LiveAssistant, content: LiveContentPart[]): LiveAssistant {
  return { ...assistant, content, ...liveContentSummary(content) };
}

function persistedToolToLive(tool: ToolPart): LiveTool {
  const toolState = tool.state;
  const inputText =
    toolState.status === "streaming" ? toolState.input : JSON.stringify(toolState.input);
  return {
    id: tool.id,
    name: tool.name,
    inputText,
    input: toolState.status === "streaming" ? undefined : toolState.input,
    status: toolState.status,
    content: "content" in toolState ? toolState.content : undefined,
    metadata: "metadata" in toolState ? toolState.metadata : undefined,
    error: toolState.status === "error" ? toolState.error : undefined,
    executed: tool.executed,
    created: tool.time.created,
    ran: tool.time.ran,
    completed: tool.time.completed,
  };
}

function liveAssistantFromPersisted(sessionID: string, message: AssistantMessage): LiveAssistant {
  const ordinal = { text: 0, reasoning: 0 };
  const content = message.content.map((part): LiveContentPart => {
    if (part.type === "tool") return { type: "tool", tool: persistedToolToLive(part) };
    const currentOrdinal = ordinal[part.type]++;
    return { type: part.type, ordinal: currentOrdinal, text: part.text };
  });
  const assistant: LiveAssistant = {
    sessionID,
    id: message.id,
    agent: message.agent,
    model: message.model,
    content: [],
    text: "",
    reasoning: "",
    tools: new Map(),
    finish: message.finish,
    cost: message.cost,
    error: message.error,
    started: message.time.created,
    completed: message.time.completed,
  };
  return withLiveContent(assistant, content);
}

function mergeStreamText(base: string, current: string): string {
  if (!base) return current;
  if (!current) return base;
  if (current.startsWith(base) || base.endsWith(current)) return current.length >= base.length ? current : base;
  if (base.startsWith(current)) return base;
  return `${base}${current}`;
}

/**
 * Append one streaming delta onto a buffered part, tolerating REPLAYED
 * deltas. Measured on engine 1.18.23 a FRESH /api/event subscription
 * receives only future events, so a page load's seeded parts normally meet
 * zero duplicates; this guard covers engines/modes that resend a tail on
 * (re)connect, where seenEventIDs cannot help across a reload. A chunk
 * already contained in the buffer's tail contributes nothing; a chunk
 * straddling the tail appends only its non-overlapping remainder.
 * Pathological overlaps self-heal at the next part boundary —
 * text/reasoning/input `.ended` events REPLACE the buffer authoritatively,
 * and the 2s poll re-merges the persisted snapshot over the live parts.
 */
function appendStreamDelta(base: string, chunk: string): string {
  if (!chunk) return base;
  if (!base) return chunk;
  if (base.endsWith(chunk)) return base;
  const maxOverlap = Math.min(base.length, chunk.length - 1);
  for (let k = maxOverlap; k > 0; k--) {
    if (base.endsWith(chunk.slice(0, k))) return base + chunk.slice(k);
  }
  return base + chunk;
}

function livePartKey(part: LiveContentPart): string {
  return part.type === "tool" ? `tool:${part.tool.id}` : `${part.type}:${part.ordinal}`;
}

function mergePersistedIntoLive(live: LiveAssistant, message: AssistantMessage): LiveAssistant {
  const persisted = liveAssistantFromPersisted(live.sessionID, message);
  if (live.content.length === 0) {
    return { ...persisted, id: live.id, started: live.started, sessionID: live.sessionID };
  }

  const currentByKey = new Map(live.content.map((part) => [livePartKey(part), part]));
  const content = persisted.content.map((part) => {
    const current = currentByKey.get(livePartKey(part));
    if (!current) return part;
    if (part.type === "tool" && current.type === "tool") {
      const persistedTool = part.tool;
      const currentTool = current.tool;
      return {
        type: "tool" as const,
        tool: {
          ...persistedTool,
          ...currentTool,
          inputText: mergeStreamText(persistedTool.inputText, currentTool.inputText),
          input: currentTool.input ?? persistedTool.input,
          status:
            currentTool.status === "streaming" && persistedTool.status !== "streaming"
              ? persistedTool.status
              : currentTool.status,
          content: currentTool.content ?? persistedTool.content,
          metadata: currentTool.metadata ?? persistedTool.metadata,
          error: currentTool.error ?? persistedTool.error,
          executed: currentTool.executed ?? persistedTool.executed,
          created: persistedTool.created ?? currentTool.created,
          ran: currentTool.ran ?? persistedTool.ran,
          completed: currentTool.completed ?? persistedTool.completed,
        },
      };
    }
    if (part.type !== "tool" && current.type !== "tool") {
      return { ...part, text: mergeStreamText(part.text, current.text) };
    }
    return part;
  });
  const persistedKeys = new Set(content.map(livePartKey));
  content.push(...live.content.filter((part) => !persistedKeys.has(livePartKey(part))));
  return withLiveContent(
    {
      ...live,
      agent: live.agent ?? persisted.agent,
      model: live.model ?? persisted.model,
      finish: live.finish ?? persisted.finish,
      cost: live.cost ?? persisted.cost,
      error: live.error ?? persisted.error,
      completed: live.completed ?? persisted.completed,
    },
    content,
  );
}

/**
 * Reconcile this session's live projections with fetched history — and,
 * crucially, SEED them from it. History mid-run includes the trailing
 * assistant message(s) still being written (time.completed unset, content
 * persisted incrementally), so a page load / pane mount / navigation while a
 * run is in flight can reconstruct the stream FROM ITS BEGINNING instead of
 * showing an empty live block that only grows from the next arriving delta.
 *
 * Seeding is gated on live signals (running/queued/engine-active, or the
 * session already projecting): an idle session's unfinished rows are a dead
 * run's debris, not a stream to resurrect. Existing entries merge with their
 * persisted twins by id (mergePersistedIntoLive); missing ones are created.
 */
function hydrateLiveFromHistory(sessionID: string, history: MessageInfo[]) {
  // CLIENT-SIDE persistence: if we have a buffered live stream from before a
  // hard refresh, restore it immediately — history's assistant.text stays ""
  // until execution.succeeded so seeding from history is useless for text.
  // Do this before any gating so a mid-stream refresh rebuilds from the start.
  if (liveForSession(sessionID).length === 0) {
    tryRestoreLiveFromStorage(sessionID);
  }
  // Use shouldTrackLive (pane + currentSession + already-live) instead of
  // isPaneSession alone: on initial load panes[0] is {id:"main",sessionID:null}
  // until selectSession runs, and early SSE deltas would otherwise be dropped.
  if (!shouldTrackLive(sessionID) && !isPaneSession(sessionID)) return;
  const hasRestoredLive = liveForSession(sessionID).length > 0;
  const isCurrent = sessionID === state.currentSessionID;
  const runInFlight =
    !!state.running[sessionID] ||
    !!state.queued[sessionID] ||
    state.activeIDs.includes(sessionID) ||
    hasRestoredLive;
  // With localStorage restore we can rebuild even if the engine hasn't flagged
  // the session active yet (refreshSessions is async). History seeding alone
  // would still yield empty text, but the restored buffer gives us the start.
  if (!runInFlight && !(isCurrent && hasRestoredLive)) return;

  const persisted = new Map(
    history
      .filter((message): message is AssistantMessage => message.type === "assistant" && isUnfinishedAssistant(message))
      .map((message) => [message.id, message]),
  );
  const knownIDs = new Set(liveForSession(sessionID).map((a) => a.id));
  // Seed in history order so multiple reconstructed steps keep their
  // transcript order inside the live block.
  const seeded: LiveAssistant[] = [];
  for (const message of history) {
    if (message.type !== "assistant" || !isUnfinishedAssistant(message) || knownIDs.has(message.id)) continue;
    knownIDs.add(message.id);
    seeded.push(liveAssistantFromPersisted(sessionID, message));
  }

  let changed = false;
  let live = state.live.map((assistant) => {
    if (assistant.sessionID !== sessionID) return assistant;
    const message = persisted.get(assistant.id);
    if (!message) return assistant;
    const next = mergePersistedIntoLive(assistant, message);
    changed ||= next !== assistant;
    return next;
  });
  if (seeded.length > 0) {
    log("load", `seeded ${seeded.length} in-flight assistant(s) for ${sessionID}`);
    live = [...live, ...seeded];
    changed = true;
  }
  if (changed) setState({ live });
}

function liveOverlayIDs(sessionID: string, history: MessageInfo[]): Set<string> {
  const fetched = new Map(history.map((message) => [message.id, message]));
  return new Set(
    liveForSession(sessionID)
      .filter((live) => {
        const persisted = fetched.get(live.id);
        return live.id !== "pending" && (!persisted || isUnfinishedAssistant(persisted));
      })
      .map((live) => live.id),
  );
}

function mergeFetchedMessages(sessionID: string, history: MessageInfo[]): MessageInfo[] {
  const existing = state.messages[sessionID] ?? [];
  const overlayIDs = liveOverlayIDs(sessionID, history);
  const existingUserCounts = new Map<string, number>();
  const fetchedUserCounts = new Map<string, number>();
  for (const message of existing) {
    if (message.type === "user" && !message.id.startsWith("msg_local_")) {
      existingUserCounts.set(message.text, (existingUserCounts.get(message.text) ?? 0) + 1);
    }
  }
  for (const message of history) {
    if (message.type === "user") {
      fetchedUserCounts.set(message.text, (fetchedUserCounts.get(message.text) ?? 0) + 1);
    }
  }
  const optimisticRemoval = new Map<string, number>();
  for (const [text, count] of fetchedUserCounts) {
    const extra = count - (existingUserCounts.get(text) ?? 0);
    if (extra > 0) optimisticRemoval.set(text, extra);
  }
  const merged = new Map<string, MessageInfo>();

  for (const message of existing) {
    if (overlayIDs.has(message.id)) continue;
    if (message.id.startsWith("msg_local_") && message.type === "user") {
      const remaining = optimisticRemoval.get(message.text) ?? 0;
      if (remaining > 0) {
        optimisticRemoval.set(message.text, remaining - 1);
        continue;
      }
    }
    merged.set(message.id, message);
  }
  for (const message of history) {
    if (!overlayIDs.has(message.id)) merged.set(message.id, message);
  }

  return [...merged.values()].sort(
    (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
  );
}

function applyFetchedMessages(sessionID: string, history: MessageInfo[]) {
  hydrateLiveFromHistory(sessionID, history);
  const merged = mergeFetchedMessages(sessionID, history);
  if (!isPaneSession(sessionID)) {
    // Background (unmounted) session: merge the transcript AND retire its
    // live entries — settled ones (persisted completed) and ghosts (never
    // persisted, session idle, past the grace window). Without this a
    // finished background run kept its live entry forever and haunted the
    // ActivityStrip ("active" while actually stopped).
    const fetchedByID = new Map(history.map((message) => [message.id, message]));
    const idle = !state.running[sessionID] && !state.queued[sessionID];
    const own = liveForSession(sessionID);
    const retired = new Set(
      own
        .filter((live) => {
          if (live.id === "pending") return false;
          if (idle && !fetchedByID.has(live.id) && Date.now() - live.started > 30_000) return true;
          const persisted = fetchedByID.get(live.id);
          return persisted?.type === "assistant" && persisted.time.completed !== undefined;
        })
        .map((live) => live.id),
    );
    const nextLive =
      retired.size > 0
        ? state.live.filter((live) => !(live.sessionID === sessionID && retired.has(live.id)))
        : state.live;
    setState({
      messages: { ...state.messages, [sessionID]: merged },
      ...(nextLive !== state.live ? { live: nextLive } : {}),
    });
    if (own.length > 0 && retired.size === own.length) clearPersistedLive(sessionID);
    return;
  }

  const fetchedByID = new Map(history.map((message) => [message.id, message]));
  // Strictly THIS session's live entries — another pane's pending placeholder
  // or ghost must never be settled/collected by this session's fetch.
  const own = liveForSession(sessionID);
  const pending = own.find((live) => live.id === "pending");
  const pendingSettled = !!pending && history.some(
    (message) =>
      message.type === "assistant" &&
      message.time.completed !== undefined &&
      message.time.created >= pending.started - 5_000,
  );
  const settled = new Set(
    own
      .filter((live) => {
        const persisted = fetchedByID.get(live.id);
        return persisted?.type === "assistant" && persisted.time.completed !== undefined;
      })
      .map((live) => live.id),
  );
  // Ghost GC: a live assistant whose run is over but which never persisted
  // (aborted step, lost execution events) would linger in `state.live`
  // forever. Its old `started` timestamp then drags the transcript's live
  // insert point above newer turns — the "response renders above my message"
  // bug. Once the session is idle and the entry had a fair chance (~30s) to
  // show up in history, retire it.
  const idle = !state.running[sessionID] && !state.queued[sessionID];
  const ghosts = new Set(
    idle
      ? own
          .filter((live) => live.id !== "pending" && !fetchedByID.has(live.id) && Date.now() - live.started > 30_000)
          .map((live) => live.id)
      : [],
  );
  const running = { ...state.running };
  if (pendingSettled) {
    delete running[sessionID];
    seenExecution.delete(sessionID);
  }
  const nextLive = state.live.filter(
    (live) =>
      live.sessionID !== sessionID ||
      (live.id === "pending" ? !pendingSettled : !(settled.has(live.id) || ghosts.has(live.id))),
  );
  const hadLive = state.live.some((a) => a.sessionID === sessionID);
  const hasLive = nextLive.some((a) => a.sessionID === sessionID);
  setState({
    messages: { ...state.messages, [sessionID]: merged },
    live: nextLive,
    running,
  });
  // Clear client-side persistence once the session's live projection is fully
  // retired (completed in history or ghost-collected). Without this a later
  // refresh would resurrect stale deltas on top of completed history.
  if (hadLive && !hasLive && (settled.size > 0 || ghosts.size > 0 || pendingSettled)) {
    clearPersistedLive(sessionID);
  } else if (hadLive && !hasLive) {
    // Also clear if history now contains a completed assistant for this
    // session (covers localStorage ids that just completed).
    const hasCompleted = history.some(
      (m) => m.type === "assistant" && (m as AssistantMessage).time.completed !== undefined,
    );
    if (hasCompleted) clearPersistedLive(sessionID);
  }
}

function ensureLiveAssistant(sessionID: string, id: string, started = Date.now()): LiveAssistant {
  // Match session too: "pending" placeholders exist one PER session while two
  // panes stream simultaneously; real message ids are globally unique anyway.
  const existing = state.live.find((m) => m.sessionID === sessionID && m.id === id);
  if (existing) return existing;
  const currentMessages = state.messages[sessionID];
  const persisted = currentMessages?.find(
    (message): message is AssistantMessage =>
      message.id === id && message.type === "assistant" && isUnfinishedAssistant(message),
  );
  const fresh = persisted
    ? liveAssistantFromPersisted(sessionID, persisted)
    : {
        sessionID,
        id,
        content: [],
        text: "",
        reasoning: "",
        tools: new Map<string, LiveTool>(),
        started,
      };
  setState({
    live: [...state.live, fresh],
    ...(persisted
      ? {
          messages: {
            ...state.messages,
            [sessionID]: currentMessages!.filter((message) => message.id !== id),
          },
        }
      : {}),
  });
  if (fresh.id !== "pending") persistLiveForSession(sessionID);
  return fresh;
}

function hideUnfinishedHistory(sessionID: string, id: string) {
  const messages = state.messages[sessionID];
  if (!messages?.some((message) => message.id === id && isUnfinishedAssistant(message))) return;
  setState({
    messages: {
      ...state.messages,
      [sessionID]: messages.filter((message) => message.id !== id),
    },
  });
}

function patchLiveAssistant(id: string, patch: Partial<LiveAssistant>) {
  const sid = state.live.find((m) => m.id === id)?.sessionID;
  setState({
    live: state.live.map((m) => {
      if (m.id !== id) return m;
      const next = { ...m, ...patch, tools: new Map(m.tools) };
      return patch.content ? withLiveContent(next, patch.content) : next;
    }),
  });
  if (sid) persistLiveForSession(sid);
}

function ensureLiveContentPart(
  sessionID: string,
  assistantID: string,
  type: "text" | "reasoning",
  ordinal: number,
): LiveContentPart | undefined {
  const assistant = ensureLiveAssistant(sessionID, assistantID);
  const existing = assistant.content.find((part) => part.type === type && part.ordinal === ordinal);
  if (existing) return existing;
  const part: LiveContentPart = { type, ordinal, text: "" };
  patchLiveAssistant(assistantID, { content: [...assistant.content, part] });
  return part;
}

function patchLiveContentPart(
  assistantID: string,
  type: "text" | "reasoning",
  ordinal: number,
  text: string,
  mode: "append" | "replace",
) {
  const assistant = state.live.find((m) => m.id === assistantID);
  if (!assistant) return;
  const content = assistant.content.map((part) => {
    if (part.type !== type || part.ordinal !== ordinal) return part;
    // Append goes through the replay-safe merge: seeded parts (mid-run page
    // load) and post-reconnect duplicate deltas must not double-append.
    return { ...part, text: mode === "append" ? appendStreamDelta(part.text, text) : text };
  });
  patchLiveAssistant(assistantID, { content });
}

function ensureLiveTool(sessionID: string, assistantID: string, toolID: string, name?: string): LiveTool {
  const assistant = ensureLiveAssistant(sessionID, assistantID);
  const existing = assistant.tools.get(toolID);
  if (existing) return existing;
  const tool: LiveTool = {
    id: toolID,
    name: name ?? "tool",
    inputText: "",
    status: "streaming",
    created: Date.now(),
  };
  patchLiveAssistant(assistantID, {
    content: [...assistant.content, { type: "tool", tool }],
  });
  return tool;
}

function patchLiveTool(assistantID: string, toolID: string, patch: Partial<LiveTool>) {
  const assistant = state.live.find((m) => m.id === assistantID);
  if (!assistant) return;
  const tool = assistant.tools.get(toolID);
  if (!tool) return;
  // Undefined patch keys must NOT erase existing values: terminal events
  // (success/failed) often omit content/metadata, and spreading them would
  // wipe what the streaming events had already accumulated.
  const applied = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<LiveTool>;
  const updated = { ...tool, ...applied };
  patchLiveAssistant(assistantID, {
    content: assistant.content.map((part) =>
      part.type === "tool" && part.tool.id === toolID ? { type: "tool", tool: updated } : part,
    ),
  });
}

/**
 * Build a renderable ToolPart from a live tool. The live model keeps
 * `inputText` (raw streaming JSON) plus `input` (parsed) separately from
 * status, so we assemble the exact `ToolState` shape the ToolCard expects.
 */
export function liveToolPart(t: LiveTool): ToolPart {
  const input: unknown =
    t.status === "streaming" ? t.inputText : t.input !== undefined ? t.input : {};
  const state: ToolState =
    t.status === "error"
      ? {
          status: "error",
          input: input as Record<string, unknown>,
          error: t.error ?? { type: "error", message: "tool failed" },
          content: t.content,
        }
      : t.status === "completed"
        ? {
            status: "completed",
            input: input as Record<string, unknown>,
            content: t.content ?? [],
            metadata: t.metadata,
          }
        : t.status === "running"
          ? { status: "running", input: input as Record<string, unknown>, metadata: t.metadata }
          : { status: "streaming", input: t.inputText };
  return {
    type: "tool",
    id: t.id,
    name: t.name,
    executed: t.executed,
    state,
    time: { created: t.created ?? Date.now(), ran: t.ran, completed: t.completed },
  };
}

/**
 * `session.execution.started` has no assistantMessageID, so the store creates
 * a "pending" placeholder (one PER session — the sessionID field scopes it).
 * Once the first `session.step.started` reveals the real assistant message
 * id, re-key that session's placeholder to it so we never render a duplicated
 * "thinking…" block plus the real stream.
 */
function adoptPendingAssistant(sessionID: string, id: string, patch: Pick<LiveAssistant, "agent" | "model">) {
  const pending = state.live.find(
    (m) =>
      m.sessionID === sessionID && m.id === "pending" && m.text === "" && m.reasoning === "" && m.tools.size === 0,
  );
  if (!pending) {
    ensureLiveAssistant(sessionID, id);
    patchLiveAssistant(id, patch);
    return;
  }
  // A live entry with the real id may ALREADY exist and carry content —
  // seeded from persisted history after a mid-run page load. The empty
  // placeholder must then simply go away: re-keying it over the seeded
  // entry would erase the reconstructed stream.
  const existing = state.live.find((m) => m.sessionID === sessionID && m.id === id);
  if (existing && (existing.content.length > 0 || existing.tools.size > 0)) {
    setState({
      live: state.live
        .filter((m) => m !== pending)
        .map((m) =>
          m === existing ? { ...m, ...patch, tools: new Map(m.tools) } : m,
        ),
    });
    persistLiveForSession(sessionID);
    return;
  }
  setState({
    live: state.live
      .map((m) =>
        m === pending ? { ...m, ...patch, id } : m.sessionID === sessionID && m.id === id ? null : m,
      )
      .filter((m): m is LiveAssistant => m !== null),
  });
  if (id !== "pending") persistLiveForSession(sessionID);
}

// ---- authoritative session detail & model pinning -----------------------

export async function loadSessionDetail(sessionID: string) {
  // The draft has no server-side session; fetching would just 404-log.
  if (isDraftSession(sessionID)) return;
  try {
    const res = await api.getSession(sessionID);
    const detail = res.data;
    // First-sight adoption only: if a revert event or local action already
    // set/cleared the marker, a fetched detail (whose snapshot may predate
    // the commit) must not resurrect or contradict it.
    let markers = state.revertMarkers;
    if (markers[sessionID] === undefined) {
      const staged = (detail as { revert?: { messageID?: string } }).revert?.messageID;
      if (staged) markers = { ...markers, [sessionID]: staged };
    }
    setState({
      sessionDetails: { ...state.sessionDetails, [sessionID]: detail },
      ...(markers !== state.revertMarkers ? { revertMarkers: markers } : {}),
    });
  } catch (err) {
    console.warn("loadSessionDetail failed:", err);
  }
}

let defaultModelPromise: Promise<ModelRef | undefined> | null = null;

/**
 * The model the UI considers the default: the primary agent's pinned model
 * (usually `build`). New sessions are created with model:null and the service
 * silently resolves its OWN default at run time (which may differ — e.g. a
 * rate-limited provider). We pin the session to this model so what the picker
 * shows is exactly what executes.
 */
export function resolveDefaultModel(): Promise<ModelRef | undefined> {
  defaultModelPromise ??= (async () => {
    try {
      const agents = await api.agents();
      const primary = agents.find((a) => a.mode === "primary" && !a.hidden);
      if (primary?.model) return primary.model;
    } catch {
      /* fall through */
    }
    try {
      const models = await api.models();
      const enabled = models.filter((m) => m.enabled);
      if (enabled.length > 0) {
        return { id: enabled[0]!.modelID, providerID: enabled[0]!.providerID };
      }
    } catch {
      /* no models */
    }
    return undefined;
  })();
  return defaultModelPromise;
}

/**
 * Commit any uncommitted agent/model picks right before a message goes out.
 * A pick switched back before any send simply evaporates — nothing was ever
 * written engine-side.
 */
async function commitPendingSelections(sessionID: string) {
  if (state.pendingAgent && !isDraftSession(sessionID)) {
    const agent = state.pendingAgent;
    try {
      await api.switchAgent(sessionID, agent);
      log("model", `committed agent ${agent} on send`);
    } catch (err) {
      console.warn("switchAgent on send failed:", err);
    }
    setState({ pendingAgent: null });
  }
  if (state.pendingModel && !isDraftSession(sessionID)) {
    const model = state.pendingModel;
    try {
      await api.switchModel(sessionID, model);
      log("model", `committed model ${model.providerID}/${model.id} on send`);
    } catch (err) {
      console.warn("switchModel on send failed:", err);
    }
    setState({ pendingModel: null });
  }
}

async function ensureSessionModel(sessionID: string) {
  if (isDraftSession(sessionID)) return; // draft pins its model at creation
  // A pending (uncommitted) pick satisfies the "session must have a model"
  // invariant — it will be committed right below before the prompt goes out.
  if (state.sessions.find((s) => s.id === sessionID)?.model || state.pendingModel) {
    await commitPendingSelections(sessionID);
    return;
  }
  const m = await resolveDefaultModel();
  if (m) {
    try {
      await api.switchModel(sessionID, m);
      log("model", `pinned ${sessionID} -> ${m.providerID}/${m.id}`);
    } catch (err) {
      console.warn("ensureSessionModel failed:", err);
    }
  }
}

// ---- settle live messages after execution finishes ----------------------

async function settleLiveMessages(sessionID: string) {
  await loadMessages(sessionID);
  const liveIDs = liveForSession(sessionID)
    .filter((m) => m.id !== "pending")
    .map((m) => m.id);
  if (liveIDs.length === 0) return;
  const history = state.messages[sessionID] ?? [];
  const missing = liveIDs.filter((id) => !history.some((h) => h.id === id));
  if (missing.length > 0) {
    // The write may have lagged the finish event; retry once shortly after.
    setTimeout(() => void loadMessages(sessionID), 1500);
  }
}

// ---- run notices ---------------------------------------------------------

const RUN_NOTICES_MAX = 3;
/** SSE reconnects replay recent events; an identical note inside this window is a replay, not a fresh incident. */
const RUN_NOTICE_DEDUPE_MS = 15_000;

let runNoticeSeq = 0;

function setRunNotices(sessionID: string, list: RunNotice[] | null) {
  const next = { ...state.runNotices };
  if (list && list.length > 0) next[sessionID] = list;
  else delete next[sessionID];
  setState({ runNotices: next });
}

function clearRunNotices(sessionID: string) {
  if (state.runNotices[sessionID]) setRunNotices(sessionID, null);
}

/** Retries are moot once their run has ended one way or another. */
function expireRetryNotices(sessionID: string) {
  const list = state.runNotices[sessionID];
  if (!list?.some((n) => n.kind === "retry")) return;
  setRunNotices(sessionID, list.filter((n) => n.kind !== "retry"));
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: string; message?: string };
  const t = (e.type ?? "").toLowerCase();
  const m = (e.message ?? "").toLowerCase();
  return t === "aborted" || t === "abort" || m.includes("aborted") || m.includes("step interrupted") || m.includes("run interrupted") || m.includes("interrupted");
}

function pushRunNotice(sessionID: string, kind: RunNoticeKind, text: string, at = Date.now()) {
  if (!sessionID || isDraftSession(sessionID)) return;
  // User-initiated interrupts are not errors: Esc aborts the step which
  // surfaces as "aborted: Step interrupted" via step.failed + execution.interrupted.
  // Showing two red/amber notices for an intentional cancel is noise.
  if (kind === "interrupted") return;
  if (kind === "failed" && /aborted|step interrupted|run interrupted/i.test(text)) return;
  const list = state.runNotices[sessionID] ?? [];
  const last = list[list.length - 1];
  if (last && last.kind === kind && last.text === text && at - last.at < RUN_NOTICE_DEDUPE_MS) return;
  const notice: RunNotice = { id: `rn_${++runNoticeSeq}`, kind, text, at };
  setRunNotices(sessionID, [...list, notice].slice(-RUN_NOTICES_MAX));
}

/** Dismiss one rendered run notice. */
export function dismissRunNotice(sessionID: string, id: string) {
  const list = state.runNotices[sessionID];
  if (!list?.some((n) => n.id === id)) return;
  setRunNotices(
    sessionID,
    list.filter((n) => n.id !== id),
  );
}

// ---- event handling -----------------------------------------------------

// In some deployments the service emits session.execution.* events; in others
// it folds queued messages into the active run without one. `seenExecution`
// remembers which sessions gave us a real execution.started so we can fall
// back to step-level signals without double-clearing the running flag.
const seenExecution = new Set<string>();
const seenEventIDs = new Set<string>();
const LIVE_TYPES = new Set([
  "session.execution.started", "session.execution.succeeded", "session.execution.failed",
  "session.execution.interrupted", "session.step.started", "session.step.ended", "session.step.failed",
  "session.text.started", "session.text.delta", "session.text.ended",
  "session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended",
  "session.tool.called", "session.tool.input.started", "session.tool.input.delta",
  "session.tool.input.ended", "session.tool.progress", "session.tool.success", "session.tool.failed",
  "session.retry.scheduled",
]);

function lastLiveAssistant(sessionID: string): LiveAssistant | undefined {
  return [...state.live]
    .reverse()
    .find((assistant) => assistant.sessionID === sessionID && assistant.id !== "pending");
}

/**
 * A tracked session is streaming — make the run state say so. step.started
 * already re-arms the flag; this covers streams whose step/execution events
 * were missed but whose deltas still arrive (tracked via running/activeIDs/
 * pane membership): without it the composer showed "idle" over a live
 * stream. Deltas only reach handlers for tracked sessions (forLive gate),
 * so promoting here can never mark an unrelated session running.
 */
function promoteRunning(sessionID: string) {
  if (!sessionID || state.running[sessionID]) return;
  log("run", `live via stream delta ${sessionID}`);
  setState({
    running: { ...state.running, [sessionID]: true },
    queued: { ...state.queued, [sessionID]: false },
  });
}

function settleRun(sessionID: string) {
  expireRetryNotices(sessionID);
  const running = { ...state.running };
  delete running[sessionID];
  seenExecution.delete(sessionID);
  noteRunEnd(sessionID);
  setState({ running, queued: { ...state.queued, [sessionID]: false } });
  if (state.live.some((assistant) => assistant.sessionID === sessionID && assistant.id === "pending")) {
    setState({
      live: state.live.filter(
        (assistant) => !(assistant.sessionID === sessionID && assistant.id === "pending"),
      ),
    });
  }
  void settleLiveMessages(sessionID);
  scheduleQueueDrain(sessionID);
  debouncedRefreshSessions();
}

function finishRun(sessionID: string, type: string, error?: StructuredError) {
  const running = { ...state.running };
  delete running[sessionID];
  seenExecution.delete(sessionID);
  noteRunEnd(sessionID);
  setState({ running, queued: { ...state.queued, [sessionID]: false } });

  if (state.live.some((assistant) => assistant.sessionID === sessionID && assistant.id === "pending")) {
    setState({
      live: state.live.filter(
        (assistant) => !(assistant.sessionID === sessionID && assistant.id === "pending"),
      ),
    });
  }
  const active = lastLiveAssistant(sessionID);
  if (active) {
    patchLiveAssistant(active.id, {
      finish:
        type === "session.execution.succeeded"
          ? "stop"
          : type === "session.execution.failed"
            ? "error"
            : "interrupted",
      error: error ?? (type === "session.execution.succeeded" ? undefined : active.error),
    });
  }
  void settleLiveMessages(sessionID);
  // Live persistence is cleared in applyFetchedMessages when the completed
  // history arrives; do not clear here or mid-stream deltas would be lost
  // before the poll reconciles.
  scheduleQueueDrain(sessionID);
  debouncedRefreshSessions();
}

export function handleEvent(event: V2Event) {
  const { type, data } = event;
  const eventSessionID = (data as { sessionID?: string }).sessionID;
  if (eventSessionID && (LIVE_TYPES.has(type) || type === "session.status")) {
    // Freshest possible liveness signal — the active-map watchdog compares
    // its age against engine-reported inactivity.
    lastLiveSignal.set(eventSessionID, Date.now());
  }
  // Replay protection covers EVERY session we track live for (pane + current +
  // already-live) — two sessions interleave on one SSE stream, so a reconnect
  // replay must not double-append either pane's text deltas.
  const shouldTrackForReplay = eventSessionID ? shouldTrackLive(eventSessionID) || isPaneSession(eventSessionID) : false;
  if (event.id && eventSessionID && shouldTrackForReplay && seenEventIDs.has(event.id)) return;
  if (event.id && eventSessionID && shouldTrackForReplay) {
    // Bounded: replay protection only matters for RECENT events; a long-lived
    // tab must not grow this set without limit. Cleared wholesale (reconnect
    // replays arrive within seconds) and on session switches.
    if (seenEventIDs.size > 20_000) seenEventIDs.clear();
    seenEventIDs.add(event.id);
  }

  const forPane = (sid?: string) => !!sid && isPaneSession(sid);
  const forLive = (sid?: string) => !!sid && shouldTrackLive(sid);

  log("evt", type, `sid=${(data as { sessionID?: string }).sessionID ?? "-"}`,
    `current=${state.currentSessionID ?? "-"}`, `mid=${(data as { assistantMessageID?: string }).assistantMessageID ?? "-"}`);

  if (eventSessionID && LIVE_TYPES.has(type) && !isPaneSession(eventSessionID) && !shouldTrackLive(eventSessionID)) {
    log("gate", `${type} for non-pane session ${eventSessionID} — skipped`);
  } else if (eventSessionID && LIVE_TYPES.has(type) && !isPaneSession(eventSessionID)) {
    log("gate", `${type} for non-pane session ${eventSessionID} — tracked via shouldTrackLive`);
  }

  switch (type) {
    case "session.created":
    case "session.renamed":
    case "session.deleted":
    case "session.moved":
    case "session.forked":
    case "session.usage.updated":
      debouncedRefreshSessions();
      if (eventSessionID && (state.messages[eventSessionID]?.length ?? 0) > 0) {
        void loadMessages(eventSessionID);
      }
      if (type !== "session.usage.updated") void loadSessionDetail(data.sessionID);
      break;

    case "session.revert.staged": {
      // The engine cut its view at this message — mirror it locally so the
      // transcript hides the undone tail the instant the event lands,
      // regardless of detail-fetch timing.
      const staged = (data as { revert?: { messageID?: string } }).revert?.messageID;
      if (eventSessionID && staged) setRevertMarker(eventSessionID, staged);
      debouncedRefreshSessions();
      if (eventSessionID && (state.messages[eventSessionID]?.length ?? 0) > 0) {
        void loadMessages(eventSessionID);
      }
      if (eventSessionID) void loadSessionDetail(data.sessionID);
      break;
    }

    case "session.revert.committed": {
      // Commit deletes the staged message AND everything after it
      // (probe-verified: history shrank to exactly the post-revert turns).
      // Apply the cut locally — client-local optimistic messages belong to
      // the NEW turn and survive. Clearing the marker also immunizes against
      // a late detail fetch still carrying the staged snapshot.
      const to = (data as { to?: string }).to;
      if (eventSessionID && to) {
        const messages = state.messages[eventSessionID] ?? [];
        const idx = messages.findIndex((m) => m.id === to);
        if (idx !== -1) {
          const cut = [
            ...messages.slice(0, idx),
            ...messages.slice(idx).filter((m) => m.id.startsWith("msg_local_")),
          ];
          setState({
            messages: { ...state.messages, [eventSessionID]: cut },
            revertMarkers: { ...state.revertMarkers, [eventSessionID]: null },
          });
        } else {
          setRevertMarker(eventSessionID, null);
        }
      }
      debouncedRefreshSessions();
      if (eventSessionID) {
        void loadMessages(eventSessionID);
        void loadSessionDetail(eventSessionID);
      }
      break;
    }

    case "session.revert.cleared":
      if (eventSessionID) setRevertMarker(eventSessionID, null);
      debouncedRefreshSessions();
      if (eventSessionID && (state.messages[eventSessionID]?.length ?? 0) > 0) {
        void loadMessages(eventSessionID);
      }
      if (eventSessionID) void loadSessionDetail(data.sessionID);
      break;

    case "session.agent.selected":
    case "session.model.selected":
      debouncedRefreshSessions();
      void loadSessionDetail(data.sessionID);
      break;

    case "session.inbox.enqueued": {
      // Hydrate a tracked row straight from the event when its shape allows
      // (defensive parse — the payload isn't in the spec). This is what makes
      // items admitted from InboxPanel/another tab visible even in sessions
      // no poll would otherwise reach.
      const ev = data as {
        id?: unknown;
        inboxID?: unknown;
        sessionID?: string;
        payload?: { text?: unknown };
        delivery?: PromptDelivery;
      };
      const evInboxID =
        typeof ev.id === "string" && ev.id
          ? ev.id
          : typeof ev.inboxID === "string" && ev.inboxID
            ? ev.inboxID
            : undefined;
      if (
        ev.sessionID &&
        !isDraftSession(ev.sessionID) &&
        evInboxID &&
        typeof ev.payload?.text === "string"
      ) {
        hydrateServerInboxItem(ev.sessionID, {
          id: evInboxID,
          text: ev.payload.text,
          delivery: ev.delivery,
        });
      }
      if (forPane(data.sessionID)) {
        log("run", `queued ${data.sessionID}`);
        setState({ queued: { ...state.queued, [data.sessionID]: true } });
      }
      break;
    }

    case "session.inbox.delivered": {
      // The item left the inbox: resolve its strip row. Payload shape isn't in
      // the spec — parse defensively; anything unmatched falls through to the
      // poll reconciler, which drops rows whose id vanished.
      const d = data as { id?: unknown; inboxID?: unknown };
      const deliveredID =
        typeof d.id === "string" && d.id
          ? d.id
          : typeof d.inboxID === "string" && d.inboxID
            ? d.inboxID
            : undefined;
      if (deliveredID) dropPendingByInboxID(deliveredID);
      break;
    }

    case "session.error":
      // Run-level failure the step/execution events don't carry (e.g.
      // provider auth errors). Surface it inline; clear any waiting state —
      // the run is over even if no terminal execution event follows.
      // Abort/interrupted errors are intentional cancels, not failures.
      if (data.sessionID) {
        const err = (data as { error?: StructuredError }).error;
        if (err && !isAbortLikeError(err)) {
          setState({
            sendErrors: {
              ...state.sendErrors,
              [data.sessionID]: { type: err.type ?? "error", message: err.message, status: err.status },
            },
          });
          pushRunNotice(data.sessionID, "error", `${err.type}: ${err.message}`, event.created);
        } else if (err && isAbortLikeError(err)) {
          // Still clear waiting state but don't surface noise.
        }
        clearPending(data.sessionID);
      }
      break;

    case "session.execution.started":
      seenExecution.add(data.sessionID);
      log("run", `started ${data.sessionID}`);
      setState({
        running: { ...state.running, [data.sessionID]: true },
        queued: { ...state.queued, [data.sessionID]: false },
      });
      ensureSessionWait(data.sessionID);
      if (forLive(data.sessionID)) ensureLiveAssistant(data.sessionID, data.assistantMessageID ?? "pending", event.created);
      break;

    case "session.retry.scheduled": {
      if (data.sessionID && data.error) {
        const attempt = (data as { attempt?: number }).attempt;
        pushRunNotice(
          data.sessionID,
          "retry",
          `Retry attempt ${attempt ?? "?"} scheduled — ${data.error.message}`,
          event.created,
        );
      }
      if (forLive(data.sessionID) && data.assistantMessageID && data.error) {
        patchLiveAssistant(data.assistantMessageID, {
          error: {
            type: data.error.type,
            message: `Retrying${data.at ? ` at ${new Date(data.at).toLocaleTimeString()}` : ""} — ${data.error.message}`,
            status: data.error.status,
          },
        });
      }
      break;
    }

    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      log("run", `finished ${data.sessionID} (${type})`);
      if (type === "session.execution.succeeded") {
        clearRunNotices(data.sessionID);
      } else {
        expireRetryNotices(data.sessionID);
        if (type === "session.execution.failed") {
          const err = data.error;
          if (err && !isAbortLikeError(err)) {
            pushRunNotice(
              data.sessionID,
              "failed",
              `${err.type}: ${err.message}`,
              event.created,
            );
          } else if (!err) {
            pushRunNotice(data.sessionID, "failed", "Run failed", event.created);
          }
        }
        // interrupted: intentional (Esc) — not an error to surface; filter in pushRunNotice
      }
      finishRun(data.sessionID, type, data.error);
      break;
    }

    case "session.step.started":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        adoptPendingAssistant(data.sessionID, data.assistantMessageID, { agent: data.agent, model: data.model });
        ensureLiveAssistant(data.sessionID, data.assistantMessageID, event.created);
        hideUnfinishedHistory(data.sessionID, data.assistantMessageID);
        patchLiveAssistant(data.assistantMessageID, {
          agent: data.agent,
          model: data.model,
          finish: undefined,
          error: undefined,
          completed: undefined,
        });
        // A step IS running — re-arm the flag unconditionally. The
        // active-map watchdog may have cleared it during a silent stretch
        // (long tool call); the next step event is the fresher truth.
        if (!state.running[data.sessionID]) {
          log("run", `live via step.started ${data.sessionID}`);
          setState({
            running: { ...state.running, [data.sessionID]: true },
            queued: { ...state.queued, [data.sessionID]: false },
          });
          ensureSessionWait(data.sessionID);
        }
      }
      break;

    case "session.step.ended":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        patchLiveAssistant(data.assistantMessageID, {
          finish: data.finish,
          cost: data.cost,
          completed: event.created,
        });
        if (!seenExecution.has(data.sessionID) && data.finish === "stop") {
          const running = { ...state.running };
          delete running[data.sessionID];
          setState({ running });
        }
      }
      break;

    case "session.step.failed":
      if (data.sessionID && data.error && !isAbortLikeError(data.error)) {
        pushRunNotice(data.sessionID, "failed", `${data.error.type}: ${data.error.message}`, event.created);
      }
      if (forLive(data.sessionID) && data.assistantMessageID) {
        patchLiveAssistant(data.assistantMessageID, {
          finish: "error",
          error: data.error,
          cost: data.cost,
          completed: event.created,
        });
        if (!seenExecution.has(data.sessionID)) {
          const running = { ...state.running };
          delete running[data.sessionID];
          setState({ running });
        }
      }
      break;

    case "session.text.started":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        promoteRunning(data.sessionID);
        ensureLiveContentPart(data.sessionID, data.assistantMessageID, "text", data.ordinal ?? 0);
        if (state.queued[data.sessionID]) setState({ queued: { ...state.queued, [data.sessionID]: false } });
      }
      break;
    case "session.text.delta":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.sessionID, data.assistantMessageID, "text", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "text", data.ordinal ?? 0, data.delta ?? "", "append");
      }
      break;
    case "session.text.ended":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.sessionID, data.assistantMessageID, "text", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "text", data.ordinal ?? 0, data.text ?? "", "replace");
      }
      break;

    case "session.reasoning.started":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        promoteRunning(data.sessionID);
        ensureLiveContentPart(data.sessionID, data.assistantMessageID, "reasoning", data.ordinal ?? 0);
      }
      break;
    case "session.reasoning.delta":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.sessionID, data.assistantMessageID, "reasoning", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "reasoning", data.ordinal ?? 0, data.delta ?? "", "append");
      }
      break;
    case "session.reasoning.ended":
      if (forLive(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.sessionID, data.assistantMessageID, "reasoning", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "reasoning", data.ordinal ?? 0, data.text ?? "", "replace");
      }
      break;

    case "session.tool.input.started":
      if (forLive(data.sessionID) && data.assistantMessageID && data.id) {
        promoteRunning(data.sessionID);
        ensureLiveTool(data.sessionID, data.assistantMessageID, data.id, data.name);
      }
      break;
    case "session.tool.input.delta":
      if (forLive(data.sessionID) && data.assistantMessageID && data.id) {
        ensureLiveTool(data.sessionID, data.assistantMessageID, data.id);
        const tool = state.live.find((m) => m.id === data.assistantMessageID)?.tools.get(data.id);
        patchLiveTool(data.assistantMessageID, data.id, {
          // Replay-safe append (see appendStreamDelta): seeded tools from a
          // mid-run page load must not double-accumulate replayed JSON.
          inputText: appendStreamDelta(tool?.inputText ?? "", data.delta ?? ""),
        });
      }
      break;
    case "session.tool.input.ended":
      if (forLive(data.sessionID) && data.assistantMessageID && data.id) {
        const tool = ensureLiveTool(data.sessionID, data.assistantMessageID, data.id);
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.text ?? "");
        } catch {
          parsed = data.text;
        }
        patchLiveTool(data.assistantMessageID, data.id, {
          input: parsed,
          inputText: data.text ?? "",
          status: tool.status === "streaming" ? "running" : tool.status,
        });
      }
      break;
    case "session.tool.called":
      if (forLive(data.sessionID) && data.assistantMessageID && data.id) {
        const tool = ensureLiveTool(data.sessionID, data.assistantMessageID, data.id);
        patchLiveTool(data.assistantMessageID, data.id, {
          input: data.input,
          inputText: data.input === undefined ? tool.inputText : JSON.stringify(data.input),
          status: tool.status === "streaming" ? "running" : tool.status,
          executed: data.executed,
          ran: event.created,
        });
      }
      break;
    case "session.tool.progress":
      if (forLive(data.sessionID) && data.assistantMessageID && data.id) {
        ensureLiveTool(data.sessionID, data.assistantMessageID, data.id);
        patchLiveTool(data.assistantMessageID, data.id, { metadata: data.metadata });
      }
      break;
    case "session.tool.success":
      if (forLive(data.sessionID) && data.assistantMessageID && data.id) {
        promoteRunning(data.sessionID);
        patchLiveTool(data.assistantMessageID, data.id, {
          ...(typeof data.name === "string" ? { name: data.name } : {}),
          status: "completed",
          content: (data.content as ToolContent[]) ?? undefined,
          metadata: data.metadata,
          executed: data.executed,
          completed: event.created,
        });
      }
      break;
    case "session.tool.failed":
      if (forLive(data.sessionID) && data.assistantMessageID && data.id) {
        patchLiveTool(data.assistantMessageID, data.id, {
          ...(typeof data.name === "string" ? { name: data.name } : {}),
          status: "error",
          error: data.error,
          content: (data.content as ToolContent[]) ?? undefined,
          metadata: data.metadata,
          executed: data.executed,
          completed: event.created,
        });
      }
      break;

    case "session.status": {
      const status = (data as { status?: { type?: string } }).status?.type;
      if (status === "busy") {
        setState({ running: { ...state.running, [data.sessionID]: true }, queued: { ...state.queued, [data.sessionID]: false } });
      } else if (status === "idle") {
        settleRun(data.sessionID);
      }
      break;
    }
    case "session.idle":
      settleRun(data.sessionID);
      break;

    case "permission.asked":
      if (!state.permissions.some((p) => p.id === data.id)) {
        setState({
          permissions: [
            ...state.permissions,
            {
              id: data.id!,
              sessionID: data.sessionID,
              action: data.action ?? "",
              resources: (data.resources as string[]) ?? [],
              seq: nextRequestSeq(),
            },
          ],
        });
      }
      break;

    // Questions-as-forms (this engine's mid-task questions) must appear the
    // instant the event lands — don't wait for the refreshQueues round-trip.
    case "form.created": {
      const form = (data as { form?: FormInfo }).form;
      if (form?.id && !state.forms.some((f) => f.id === form.id)) {
        setState({ forms: [...state.forms, { ...form, seq: nextRequestSeq() }] });
      }
      break;
    }
    case "form.replied":
    case "form.cancelled":
    case "form.deleted":
      setState({ forms: state.forms.filter((f) => f.id !== (data as { id?: string }).id) });
      break;
    case "permission.replied":
      setState({ permissions: state.permissions.filter((p) => p.id !== data.id) });
      break;

    case "question.asked":
      if (!state.questions.some((q) => q.id === data.id)) {
        const payload = data as { questions?: QuestionInfo[]; tool?: QuestionRequest["tool"] };
        setState({
          questions: [
            ...state.questions,
            {
              id: data.id!,
              sessionID: data.sessionID,
              questions: payload.questions ?? [],
              tool: payload.tool,
              seq: nextRequestSeq(),
            },
          ],
        });
      }
      break;
    case "question.replied":
    case "question.rejected":
      setState({ questions: state.questions.filter((q) => q.id !== (data as { requestID?: string }).requestID) });
      break;

    // Session shell + compaction: no true SSE streaming for output, but the
    // messages themselves update via REST polling. Nudge an immediate fetch
    // so the running block appears instantly and output "streams" via poll.
    case "session.shell.started":
    case "session.shell.ended":
      if (eventSessionID) void loadMessages(eventSessionID);
      break;
    case "session.compaction.started":
    case "session.compaction.ended":
    case "session.compaction.failed":
      if (eventSessionID) {
        void loadMessages(eventSessionID);
        void loadSessionDetail(eventSessionID);
      }
      break;

    default:
      if (type.startsWith("form.") || type.startsWith("question.") || type === "session.skill.activated") {
        void refreshQueues();
      }
      break;
  }
}

// ---- SSE-replay catch-up ---------------------------------------------------
//
// The engine does not replay history for a FRESH /api/event subscription, and
// serves no mid-stream text over REST — so a browser that attached, reloaded
// or reconnected mid-run missed everything before that moment (the "stream
// starts seconds late" bug). The proxy records session events for us; pull
// the ones we have not seen and feed them through the normal event path:
// seenEventIDs drops anything already processed, appendStreamDelta makes the
// appends overlap-safe, and out-of-order delivery cannot garble text because
// replayed events are always OLDER than everything processed after the
// reconnect point (SSE + replay are both in-order per session).

const lastReplayID = new Map<string, string>();

export async function fetchReplay(sessionID: string) {
  if (!sessionID || isDraftSession(sessionID)) return;
  noteLogHead(sessionID); // dormant v2 cursor tracking — see note at the map
  try {
    const res = await api.webuiReplay(sessionID, lastReplayID.get(sessionID));
    const events = res.data ?? [];
    for (const evt of events) {
      if (evt.id) lastReplayID.set(sessionID, evt.id);
      // Same pipeline as SSE events; dedupe is id-based downstream.
      const v2: V2Event = {
        id: evt.id,
        created: evt.created,
        type: evt.type,
        data: evt.data as V2Event["data"],
      };
      enqueueEvent(v2);
    }
    if (events.length > 0) log("sse", `replay ${sessionID}: ${events.length} event(s)`);
  } catch {
    /* older proxy without the recorder — SSE/poll still cover it */
  }
}

/** Which sessions need a catch-up pull right now. */
function replayTargets(): string[] {
  const ids = new Set<string>();
  for (const p of state.panes) if (p.sessionID) ids.add(p.sessionID);
  if (state.currentSessionID) ids.add(state.currentSessionID);
  for (const [sid, on] of Object.entries(state.running)) if (on) ids.add(sid);
  return [...ids].filter((sid) => !!sid && !isDraftSession(sid));
}

// ---- session.wait long-poll (engine-native idle signal) -------------------
//
// POST /api/session/{id}/wait resolves 204 the moment the engine's agent
// loop goes idle — a push-shaped primitive that replaces SAMPLING for run
// end (spike-verified against beta-18684: resolves at completion, resolves
// instantly when already idle, resolves on failed runs too — no hang path).
// One loop per running session:
//   - 204 → engine idle. If we still hold a running flag we missed the
//     terminal event (dead SSE) — clear it and settle history. `queued` is
//     deliberately NOT cleared here: parked inbox items resolve through
//     reconcileInbox (transcript-id drop), and wait-204 also fires while a
//     queued send sits in the engine's cold-start gap.
//   - 404 → session deleted: retire everything (pollOnce §8.1 machinery).
//   - anything else (network error, 5xx, timeout) → NOT idle truth; re-arm
//     with a small backoff while the store still considers it live.
const waitLoops = new Set<string>();
const WAIT_REARM_MS = 1_000;
const WAIT_ABORT_MS = 5 * 60_000; // client cap; a dropped wait is re-armed, never trusted as idle

/** Arms (or no-ops) the per-session wait loop. Idempotent. */
export function ensureSessionWait(sessionID: string) {
  if (!sessionID || isDraftSession(sessionID)) return;
  if (waitLoops.has(sessionID)) return;
  waitLoops.add(sessionID);
  void sessionWaitLoop(sessionID).finally(() => waitLoops.delete(sessionID));
}

async function sessionWaitLoop(sessionID: string) {
  for (;;) {
    if (!state.running[sessionID] && !state.queued[sessionID]) return;
    const status = await api
      .sessionWait(sessionID, AbortSignal.timeout(WAIT_ABORT_MS))
      .catch(() => -1);
    if (status === 204) {
      if (state.running[sessionID]) {
        log("run", `wait: engine idle ${sessionID}`);
        noteRunEnd(sessionID);
        const running = { ...state.running };
        delete running[sessionID];
        seenExecution.delete(sessionID);
        setState({ running });
        void settleLiveMessages(sessionID);
        scheduleQueueDrain(sessionID);
      }
      if (!state.running[sessionID] && !state.queued[sessionID]) return;
      // A new run started between resolution and now (or a queued send is in
      // the cold-start gap) — back off gently, then re-arm. An instant-204
      // while queued-only must not become a hot loop.
      await new Promise((r) => setTimeout(r, WAIT_REARM_MS));
      continue;
    }
    if (status === 404) {
      retireVanishedSession(sessionID, "wait 404");
      return;
    }
    if (!state.running[sessionID] && !state.queued[sessionID]) return;
    await new Promise((r) => setTimeout(r, WAIT_REARM_MS));
  }
}

// ---- v2 session-log cursor (dormant plumbing) -----------------------------
//
// The engine keeps a DURABLE per-session event log
// (GET /api/experimental/session/{id}/log) with an aggregate-seq cursor.
// On this build the head cursor works but `follow=true` streams nothing, so
// the recorder still owns catch-up — we only TRACK the head (cheap, on
// adopt/reconnect) so swapping to cursor-based catch-up later is a channel
// change, not a redesign.
const logHeadSeq = new Map<string, number>();

function noteLogHead(sessionID: string) {
  if (!sessionID || isDraftSession(sessionID)) return;
  void api
    .sessionLogHead(sessionID)
    .then((seq) => {
      if (seq === null || logHeadSeq.get(sessionID) === seq) return;
      logHeadSeq.set(sessionID, seq);
      log("sse", `log head ${sessionID}: ${seq}`);
    })
    .catch(() => undefined);
}

// ---- lifecycle ----------------------------------------------------------

let started = false;
const pendingEvents: V2Event[] = [];
let eventFlushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueEvent(event: V2Event) {
  pendingEvents.push(event);
  if (eventFlushTimer) return;
  eventFlushTimer = setTimeout(() => {
    eventFlushTimer = null;
    const events = pendingEvents.splice(0, pendingEvents.length);
    batchState(() => {
      for (const item of events) {
        // One poisoned event (malformed payload, engine surprise) must not
        // kill the REST of the batch — the stream would silently lose every
        // event after it until the next 16ms window.
        try {
          handleEvent(item);
        } catch (err) {
          console.warn("event handler failed:", item.type, err);
        }
      }
    });
  }, 16);
}

export function startStore() {
  if (started) return;
  started = true;
  log("boot", "start");
  log("boot", `build pending-panel-v6`);
  if (typeof window !== "undefined") {
    const syncLocation = () => {
      const sessionID = sessionIDFromLocation();
      if (sessionID) {
        void selectSession(sessionID, { history: "none" });
      } else if (isNewSessionRoute()) {
        // /new-session is now the free draft — nothing is created until the
        // first message is sent (materializeDraft).
        startDraftSession(null);
        void reopenLastSession().catch(() => undefined); // no-op while draft holds
      } else {
        void selectSession(null, { history: "none" });
        void reopenLastSession();
      }
    };
    window.addEventListener("popstate", syncLocation);
    // Restore pinned splits immediately (validated after sessions load).
    const restored = loadSplits();
    if (restored.length > 0) setState({ panes: [{ id: MAIN_PANE, sessionID: null }, ...restored] });
    syncLocation();
  }
  void refreshSessions().then(pruneSplits).catch(() => undefined);
  void refreshQueues();
  void api
    .health()
    .then((h) => setState({ serviceOK: h.ok }))
    .catch(() => setState({ serviceOK: false }));
  void connectEvents((env) => enqueueEvent(env.data), {
    onOpen: () => {
      setState({ connected: true });
      void refreshSessions();
      void refreshQueues();
      // (Re)connected: pull anything the dead window swallowed. The engine
      // does not replay a fresh subscription for us — the proxy recorder
      // does, and `since=<lastReplayID>` trims each pull to genuinely unseen
      // events, so a no-loss reconnect costs one near-empty request per
      // target. (A gap-based skip was tried and reverted: a 20s stall
      // "ends" a moment before its reconnect, so gap math read it as a
      // harmless blip and skipped exactly the pulls that mattered.)
      for (const sid of replayTargets()) void fetchReplay(sid);
    },
  }).then(() => setState({ connected: false }));
  startPolling();
}

// ---- scheduled poll fallback --------------------------------------------
//
// The SSE stream is the primary channel and streams character deltas. As a
// safety net (the push channel has proven flaky over the dev proxy in some
// runs), a light poll reconciles the transcript with the service while a
// session is running or has live content, so a finished answer can NEVER be
// lost behind a silent SSE hiccup.
//
// All cadences live in the scheduler (src/lib/scheduler.ts) — LIVE ~2s while
// anything is streaming/queued/pending or the SSE looks stale, IDLE ~12s in
// a visible but quiet tab, HIDDEN ~60s. The old unconditional 2s interval +
// 10s sweeps are gone; the invariants (a missed permission/form event can
// never block an agent unnoticed, a finished answer can never be lost) are
// preserved by the LIVE tier, which is exactly what "SSE dead or busy"
// computes.

function startPolling() {
  startScheduler({
    isBusy: () => {
      const s = state;
      for (const on of Object.values(s.running)) if (on) return true;
      for (const on of Object.values(s.queued)) if (on) return true;
      for (const rows of Object.values(s.pending)) if (rows.length > 0) return true;
      return s.live.length > 0;
    },
    isSseStale: sseStale,
  });
  // Transcript reconcile: no-op for free in IDLE (its target set is empty —
  // sessions with nothing live/queued/pending never fetch).
  registerPoller({
    name: "messages",
    minInterval: 2_000,
    intervals: { live: 2_000, idle: 12_000, hidden: 60_000 },
    run: () => pollOnce(),
  });
  // Permission/form queues: a missed `permission.asked`/`form.created` must
  // never leave an agent blocked unnoticed. With the SSE channel stale this
  // stays at the invariant's ~10s worst case; while healthy it may stretch.
  registerPoller({
    name: "queues",
    minInterval: 10_000,
    intervals: { live: 10_000, idle: 12_000, hidden: 60_000 },
    run: () => refreshQueues(),
  });
  // Session/active sweep: the run-state watchdog that clears stuck
  // running/queued flags lives inside refreshSessions, so it keeps a 10s
  // cadence in LIVE; deep idle stretches it (the sweep fetches the whole
  // session list — its cost is why IDLE must not run it at 10s).
  registerPoller({
    name: "sessions",
    minInterval: 10_000,
    intervals: { live: 10_000, idle: 20_000, hidden: 60_000 },
    run: () => refreshSessions(),
  });
}

async function reconcileSession(sid: string, historyAsc: MessageInfo[]) {
  // Reconcile every MOUNTED pane (main + splits) — each pane's live projection
  // settles through its own fetch; unmounted sessions are skipped.
  if (!state.panes.some((p) => p.sessionID === sid)) return;
  applyFetchedMessages(sid, historyAsc);
}

let pollInFlight = false;

async function pollOnce() {
  if (pollInFlight) return;
  const sids = new Set<string>();
  for (const [sid, on] of Object.entries(state.running)) if (on) sids.add(sid);
  // Sessions with undelivered busy-sends reconcile too — attach/drop/hydrate
  // their QueueStrip rows even when nothing else marks them live.
  for (const sid of Object.keys(state.pending)) {
    if ((state.pending[sid]?.length ?? 0) > 0 && !isDraftSession(sid)) sids.add(sid);
  }
  // ANY mounted pane with live content or a queued flag reconciles: streams
  // run in parallel across panes, so the poll safety net must cover them all.
  for (const pane of state.panes) {
    const sid = pane.sessionID;
    if (sid && !isDraftSession(sid) && (liveForSession(sid).length > 0 || state.queued[sid])) sids.add(sid);
  }
  // Sessions holding ANY live projection (background/unmounted included):
  // their transcripts must keep reconciling so finished entries can retire
  // instead of haunting the ActivityStrip forever.
  for (const a of state.live) {
    if (!isDraftSession(a.sessionID)) sids.add(a.sessionID);
  }
  if (sids.size === 0) return;

  pollInFlight = true;
  try {
    for (const sid of sids) {
      const request = beginMessageRequest(sid);
      try {
        const res = await api.messages(sid, 50);
        if (messageRequests.get(sid) !== request) continue;
        pollFailures.delete(sid);
        const before = state.messages[sid]?.length ?? 0;
        const history = [...res.data].reverse();
        await reconcileSession(sid, history);
        const after = state.messages[sid]?.length ?? 0;
        if (after !== before) log("poll", `reconcile ${sid}: ${before} -> ${after} messages`);
        // Inbox reconciliation rides the same tick as the transcript fetch:
        // attach ids to "sending" rows, drop delivered/cancelled ones, and
        // hydrate items queued from elsewhere. The queued flag also covers
        // sessions that only have the header badge so far.
        if ((state.pending[sid]?.length ?? 0) > 0 || state.queued[sid]) {
          await reconcileInbox(sid, history);
        }
      } catch (err) {
        // §8.1: a fetch that keeps failing must not churn forever. A deleted
        // session 404s on every tick while its running flag / live entries /
        // pending rows pin it into the target set (seen live: a probe session
        // deleted mid-run produced a 2s 404 loop that never ended, because
        // retirement only ran on SUCCESSFUL fetches). 404 ⇒ the session is
        // gone — retire immediately; other errors ⇒ retire after three
        // consecutive failures so a dead service can't pin state either.
        const msg = err instanceof Error ? err.message : String(err);
        const f = pollFailures.get(sid) ?? { count: 0 };
        f.count += 1;
        pollFailures.set(sid, f);
        if (msg.includes("404") || f.count >= 3) {
          retireVanishedSession(sid, msg);
          pollFailures.delete(sid);
        }
      }
    }
  } finally {
    pollInFlight = false;
  }
}

/** Consecutive message-fetch failures per session (see pollOnce). */
const pollFailures = new Map<string, { count: number }>();

/**
 * A session the engine no longer serves (deleted, or the service lost it):
 * drop every client-side pin — running/queued flags, live projection,
 * pending inbox rows, replay cursor — so the poll target set actually
 * shrinks instead of looping on 404s forever.
 */
function retireVanishedSession(sessionID: string, reason: string) {
  log("poll", `retiring vanished session ${sessionID} (${reason})`);
  const running = { ...state.running };
  delete running[sessionID];
  const queued = { ...state.queued };
  delete queued[sessionID];
  const pending = { ...state.pending };
  delete pending[sessionID];
  seenExecution.delete(sessionID);
  lastRunEnd.delete(sessionID);
  lastLiveSignal.delete(sessionID);
  lastReplayID.delete(sessionID);
  const drainTimer = queueDrainTimers.get(sessionID);
  if (drainTimer) {
    clearTimeout(drainTimer);
    queueDrainTimers.delete(sessionID);
  }
  setState({
    running,
    queued,
    pending,
    live: state.live.filter((a) => a.sessionID !== sessionID),
  });
  clearPersistedLive(sessionID);
  pollFailures.delete(sessionID);
}

// ---- actions ------------------------------------------------------------

/** Ask any mounted ShellPanel to open/focus (see State.shellPanelTick). */
export function requestShellPanel() {
  setState({ shellPanelTick: state.shellPanelTick + 1 });
}

/** Fire a one-shot UI open request (see State.uiSignals). */
export function signalUI(key: keyof UiSignals) {
  if (key === "runsDialog") {
    setState({ runsPanelOpen: true, uiSignals: { ...state.uiSignals, [key]: state.uiSignals[key] + 1 } });
    return;
  }
  setState({ uiSignals: { ...state.uiSignals, [key]: state.uiSignals[key] + 1 } });
}

export function openRunsPanel() {
  setState({ runsPanelOpen: true, uiSignals: { ...state.uiSignals, runsDialog: state.uiSignals.runsDialog + 1 } });
}

export function closeRunsPanel() {
  if (!state.runsPanelOpen) return;
  setState({ runsPanelOpen: false });
}

/** Persisted RunsPanel cursor — see State.runsSelection. */
export interface RunsSelection {
  section: "subagents" | "shells";
  /** Highlighted subagent, tracked by ID (indexes shift with sort order). */
  subID: string | null;
  /** Highlighted shell/PTY row. */
  shellIndex: number;
}

/** RunsPanel writes its cursor through on every selection change. */
export function setRunsSelection(sel: RunsSelection) {
  setState({ runsSelection: sel });
}

/** Subagent pages gate the composer behind an "Enter to message" hint. */
export function revealSubagentComposer() {
  if (state.subagentComposerOpen) return;
  setState({ subagentComposerOpen: true });
}

/** Composer takes ownership of /undo's restored text. */
export function consumeRevertPrompt(): string | null {
  const value = state.revertPrompt;
  if (state.revertPrompt !== null) setState({ revertPrompt: null });
  return value;
}

/** Child/subagent sessions of the given parent, newest first. */
export function childSessionsOf(sessions: SessionInfo[], parentID: string): SessionInfo[] {
  return sessions
    .filter((s) => s.parentID === parentID)
    .sort((a, b) => b.time.updated - a.time.updated);
}

/**
 * Tab-title liveness (mirrors Sidebar's subagent pulse and the "live =
 * running OR queued" idiom everywhere else): true when the session itself
 * OR any of its child/subagent sessions is running or queued. Deliberately
 * a cheap scan over the session list + two record lookups per child — safe
 * to run from a selector on every store change.
 */
export function sessionOrSubagentsLive(s: State, id: string | null | undefined): boolean {
  if (!id) return false;
  if (s.running[id] || s.queued[id]) return true;
  for (const child of s.sessions) {
    if (child.parentID === id && (s.running[child.id] || s.queued[child.id])) return true;
  }
  return false;
}

/**
 * TUI messagesBeforeRevert: with a staged revert the transcript is cut at
 * the revert message (exclusive) — the service still returns full history.
 */
export function applyRevertView<T extends { id: string }>(messages: T[], revertMessageID?: string): T[] {
  if (!revertMessageID) return messages;
  const index = messages.findIndex((m) => m.id === revertMessageID);
  return index === -1 ? messages : messages.slice(0, index);
}

/**
 * The authoritative revert view cut per session (see State.revertMarkers).
 * Undefined (never touched) → fall back to the fetched session detail so a
 * page load mid-staged-undo still cuts; any event or local action owns it
 * from then on.
 */
export function revertMarkerFor(s: State, sessionID: string, detail?: SessionInfo): string | undefined {
  const marker = s.revertMarkers[sessionID];
  if (marker !== undefined) return marker ?? undefined;
  const d = detail ?? s.sessionDetails[sessionID];
  return (d as { revert?: { messageID?: string } } | undefined)?.revert?.messageID;
}

function setRevertMarker(sessionID: string, messageID: string | null) {
  if (state.revertMarkers[sessionID] === messageID) return;
  setState({ revertMarkers: { ...state.revertMarkers, [sessionID]: messageID } });
}

/**
 * A prompt commit-consumes a staged revert engine-side (verified: sending a
 * prompt with a staged revert fires `session.revert.committed` and shrinks
 * history). Apply the local cut BEFORE the prompt goes out so the send never
 * races the async detail refresh (the stale-detail race that made an edited
 * message show twice, old and new). The marker itself stays SET until the
 * engine's `session.revert.committed` event lands — it remains a correct
 * view cut the whole time, and clearing it early would let a pre-commit
 * refetch flash the old turns back in.
 */
function commitRevertOptimistically(sessionID: string) {
  const revertID = revertMarkerFor(state, sessionID);
  if (!revertID) return;
  const truncated = applyRevertView(state.messages[sessionID] ?? [], revertID);
  setState({ messages: { ...state.messages, [sessionID]: truncated } });
}

export async function selectSession(
  sessionID: string | null,
  options: { history?: "push" | "replace" | "none" } = {},
) {
  log("session", "select", sessionID ?? "null");
  if (options.history !== "none") updateSessionHistory(sessionID, options.history ?? "push");
  // A reconnect can replay events that were already handled before navigation;
  // the newly selected session must be allowed to hydrate from that replay.
  seenEventIDs.clear();
  if (sessionID === DRAFT_SESSION_ID) {
    const nextPanes = withMainPaneSession(DRAFT_SESSION_ID);
    setState({
      currentSessionID: DRAFT_SESSION_ID,
      // Keep streams of sessions still mounted in other panes; drop the rest.
      live: pruneLiveForPanes(nextPanes),
      subagentComposerOpen: false,
      panes: nextPanes,
      focusedPane: MAIN_PANE,
    });
    return;
  }
  const nextPanes = withMainPaneSession(sessionID);
  setState({
    currentSessionID: sessionID,
    // Prune instead of clearing: split panes' live streams survive focus
    // switches; only unmounted sessions' entries go.
    live: pruneLiveForPanes(nextPanes),
    subagentComposerOpen: false,
    // Explicit navigation always lands on the routed surface and re-points
    // the main pane — splits keep their pinned sessions untouched.
    panes: nextPanes,
    focusedPane: MAIN_PANE,
    // Stale-hygiene only, and pane-isolated by construction: a session lives
    // in exactly ONE pane, so this touches the incoming session's own flag
    // alone (a genuinely queued run re-sets it from the next engine event).
    queued: sessionID ? { ...state.queued, [sessionID]: false } : state.queued,
  });
  if (sessionID) {
    rememberLastSession(sessionID);
    // Restore any buffered live stream from before a hard refresh
    // before the history fetch returns, so the transcript appears
    // immediately from the start rather than after the next delta.
    tryRestoreLiveFromStorage(sessionID);
    // Catch up on anything streamed before we attached (mid-run join):
    // the recorder holds the deltas the engine will never re-serve.
    void fetchReplay(sessionID);
    // Navigating to a real session discards the pending draft — the draft
    // only exists while it IS the current surface.
    if (state.draftWorkspace !== null) setState({ draftWorkspace: null });
    if (!state.sessions.some((s) => s.id === sessionID) && !state.sessionDetails[sessionID]) {
      void loadSessionDetail(sessionID);
    }
    await loadMessages(sessionID);
    // Surface undelivered busy-sends immediately (items queued from
    // InboxPanel/another tab) instead of waiting for the next poll tick.
    void reconcileInbox(sessionID).catch(() => undefined);
  } else if (state.draftWorkspace !== null) {
    setState({ draftWorkspace: null });
  }
}

// ---- split view -----------------------------------------------------------
//
// VS Code-style panes. The main pane stays bound to routing/history
// (selectSession writes it); additional panes pin OTHER sessions beside it
// and stay fully interactive — sends are fire-and-forget per session and
// the SSE stream is global, so a background pane keeps running.
//
// Focus model: exactly one pane owns the global single-session machinery
// (Esc interrupt, dirty agent/model picks, runs panel, type-anywhere). The
// live streaming projection is PER PANE — every mounted session streams and
// renders its own entries regardless of focus, so NOTHING happening in one
// pane (stream start, deltas, step ends, run end, queue changes) can render
// in or gate another: event handlers scope by the event's sessionID, every
// component selects by its own sessionID prop, and a session can never sit
// in two panes at once. Focusing a pane points currentSessionID at its
// session WITHOUT touching history, drafts or pane bindings — cached
// transcripts paint instantly and the refresh only reconciles.

const SPLITS_KEY = "webui.splits";
let paneSeq = 0;

function withMainPaneSession(sessionID: string | null): SplitPane[] {
  const panes = state.panes.length > 0 ? state.panes.slice() : [{ id: MAIN_PANE, sessionID: null as string | null }];
  panes[0] = { id: MAIN_PANE, sessionID };
  return panes;
}

function saveSplits() {
  try {
    localStorage.setItem(SPLITS_KEY, JSON.stringify(state.panes.slice(1)));
  } catch {
    /* private mode */
  }
}

function loadSplits(): SplitPane[] {
  try {
    const raw = localStorage.getItem(SPLITS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SplitPane[];
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is SplitPane =>
            !!p && typeof p.id === "string" && typeof p.sessionID === "string" && p.id !== MAIN_PANE,
        )
      : [];
  } catch {
    return [];
  }
}

/** Drop restored panes whose session no longer exists (boot-time prune). */
function pruneSplits() {
  const known = (sid: string) => state.sessions.some((s) => s.id === sid) || !!state.sessionDetails[sid];
  const kept = state.panes.filter((p, i) => i === 0 || known(p.sessionID!));
  if (kept.length !== state.panes.length) {
    const focusedGone = !kept.some((p) => p.id === state.focusedPane);
    setState({
      panes: kept,
      ...(focusedGone ? { focusedPane: MAIN_PANE } : {}),
    });
  }
}

/**
 * Point the global single-session machinery at a session, minus every side
 * effect of real navigation: no history push, no draft discard, no pane
 * re-binding. This is what makes pane focus feel instant.
 */
async function adoptFocusedSession(sessionID: string | null) {
  if (state.currentSessionID === sessionID) return;
  setState({
    currentSessionID: sessionID,
    // Focus switches must NOT drop other panes' streams — prune only entries
    // whose session is no longer mounted anywhere.
    live: pruneLiveForPanes(state.panes),
    subagentComposerOpen: false,
    // Uncommitted agent/model picks belong to the pane being left — they
    // were never sent anywhere, so drop them instead of leaking over.
    pendingAgent: null,
    pendingModel: null,
    // Same stale-hygiene as selectSession, same isolation argument: the
    // flag belongs to the newly focused session's single pane only. Live
    // projections and other panes' run state are untouched.
    ...(sessionID ? { queued: { ...state.queued, [sessionID]: false } } : {}),
  });
  if (sessionID && !isDraftSession(sessionID)) {
    tryRestoreLiveFromStorage(sessionID);
    // Same catch-up as selectSession — pane focus counts as attaching.
    void fetchReplay(sessionID);
    await loadMessages(sessionID);
    void reconcileInbox(sessionID).catch(() => undefined);
  }
}

/** Move focus to a pane; its session becomes the globally-active one. */
export async function focusPane(paneID: string) {
  const pane = state.panes.find((p) => p.id === paneID);
  if (!pane) return;
  if (state.focusedPane === paneID) return;
  log("pane", `focus ${paneID}`);
  setState({ focusedPane: paneID });
  await adoptFocusedSession(pane.sessionID);
}

export function openSplitPicker() {
  setState({ splitPickerOpen: true });
}

export function closeSplitPicker() {
  if (state.splitPickerOpen) setState({ splitPickerOpen: false });
}

export async function addSplitPane(sessionID: string): Promise<boolean> {
  if (!sessionID || isDraftSession(sessionID)) return false;
  if (state.panes.length - 1 >= MAX_SPLITS) return false;
  if (state.panes.some((p) => p.sessionID === sessionID)) return false;
  const pane: SplitPane = { id: `${MAIN_PANE}-${Date.now().toString(36)}-${++paneSeq}`, sessionID };
  log("pane", `split open ${sessionID} (${pane.id})`);
  setState({
    panes: [...state.panes, pane],
    focusedPane: pane.id,
    splitPickerOpen: false,
  });
  saveSplits();
  if (!state.sessions.some((s) => s.id === sessionID) && !state.sessionDetails[sessionID]) {
    void loadSessionDetail(sessionID);
  }
  await adoptFocusedSession(sessionID);
  return true;
}

export async function removeSplitPane(paneID: string) {
  if (paneID === MAIN_PANE) return;
  const panes = state.panes.filter((p) => p.id !== paneID);
  if (panes.length === state.panes.length) return;
  log("pane", `close ${paneID}`);
  const focusedGone = state.focusedPane === paneID;
  setState({ panes, ...(focusedGone ? { focusedPane: MAIN_PANE } : {}) });
  saveSplits();
  if (focusedGone) {
    await adoptFocusedSession(state.panes[0]!.sessionID);
  }
}

/** Swap which session a pinned pane shows (subagent navigation inside it). */
export async function setPaneSession(paneID: string, sessionID: string | null) {
  const idx = state.panes.findIndex((p) => p.id === paneID);
  if (idx <= 0 || !sessionID || isDraftSession(sessionID)) return;
  const panes = state.panes.slice();
  panes[idx] = { ...panes[idx]!, sessionID };
  setState({ panes });
  saveSplits();
  if (state.focusedPane === paneID) await adoptFocusedSession(sessionID);
  else void loadMessages(sessionID);
}

/**
 * Navigate the FOCUSED pane to a session: main pane → real navigation
 * (URL/history), a split pane → swap that pane's content in place.
 * All in-pane chrome (parent buttons, subagent chips, arrows) uses this.
 */
export async function navigateFocused(sessionID: string | null) {
  if (state.focusedPane === MAIN_PANE || state.panes.length <= 1) {
    await selectSession(sessionID);
    return;
  }
  await setPaneSession(state.focusedPane, sessionID);
}

/** Which pane currently owns global chrome ("main" | pane id). */
export function focusedPaneKey(s: State = getState()): string {
  return s.focusedPane;
}

/** Warm the transcript cache without touching any UI state (hover prefetch). */
export function prefetchSession(sessionID: string) {
  if (isDraftSession(sessionID)) return;
  if ((state.messages[sessionID]?.length ?? 0) > 0) return; // cached already
  void loadMessages(sessionID);
}

// ---- last-open session persistence ---------------------------------------

const LAST_SESSION_KEY = "webui.last-session";

function rememberLastSession(sessionID: string) {
  try {
    localStorage.setItem(LAST_SESSION_KEY, sessionID);
  } catch {
    /* private mode */
  }
}

/** Reopen the last active session on startup (TUI resume feel). */
async function reopenLastSession() {
  // Deep links into extension pages (/ext/…) are deliberate destinations —
  // never hijack them back into the last-open session.
  if (/^\/ext\//.test(window.location.pathname)) return;
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return;
  }
  if (!last || state.currentSessionID) return;
  await refreshSessions();
  if (state.currentSessionID || !last) return;
  if (state.sessions.some((s) => s.id === last)) {
    log("session", `reopen last session ${last}`);
    await selectSession(last, { history: "replace" });
  }
}

export async function sendPrompt(text: string) {
  const sid = state.currentSessionID;
  if (!sid) return;
  await sendPromptTo(sid, text);
}

export interface SendPromptOptions {
  /**
   * Delivery for BUSY sessions only: omitted/"steer" joins the active run at
   * the next LLM-call boundary (engine default), "queue" parks the message
   * until the current turn ends. Idle sessions ignore it — the prompt starts
   * a run immediately, exactly as before this option existed.
   */
  delivery?: PromptDelivery;
}

/**
 * Send a prompt to an explicit session — child/subagent sessions included.
 * Sessions are uniform, so messaging a child is a normal prompt against its
 * id; optimistic copies and the pending flag are keyed by that id.
 *
 * Busy sessions take the STEER vs QUEUE path instead: no optimistic
 * transcript turn — the message becomes a durable inbox item tracked in the
 * QueueStrip (see admitWhileBusy + reconcileInbox).
 */
export async function sendPromptTo(
  sessionID: string,
  text: string,
  opts?: SendPromptOptions,
) {
  log(
    "send",
    `prompt ${sessionID}: ${text.slice(0, 80)}${opts?.delivery ? ` (${opts.delivery})` : ""}`,
  );
  await ensureSessionModel(sessionID);
  if (!isDraftSession(sessionID) && sessionBusy(sessionID)) {
    commitRevertOptimistically(sessionID);
    await admitWhileBusy(sessionID, text, opts?.delivery);
    return;
  }
  commitRevertOptimistically(sessionID);
  appendOptimisticUserMessage(sessionID, text);
  markPending(sessionID);
  try {
    await api.prompt(sessionID, text);
    // Arm the engine-native idle wait even though events normally drive the
    // run lifecycle: if the SSE channel is dead at send time, wait-204 is
    // the signal that settles the transcript (the §7 staircase's floor).
    ensureSessionWait(sessionID);
    if (sessionID === DRAFT_SESSION_ID || (state.messages[DRAFT_SESSION_ID]?.length ?? 0) === 0) {
      try {
        const { clearDraft } = await import("./lib/drafts");
        clearDraft(DRAFT_SESSION_ID);
      } catch {}
    }
  } catch (err) {
    clearPending(sessionID);
    recordSendError(sessionID, err);
    throw err;
  }
}

/**
 * A session is "busy" when it is streaming (running), waiting to start
 * (queued — provider cold-start gap or messages parked behind an active
 * step), the engine reports it active, or a live projection exists for it.
 * Every mounted pane session carries its own live projection; unmounted
 * sessions rely on running/queued/activeIDs. Mirrors how Conversation
 * derives its badges.
 */
function sessionBusy(sessionID: string): boolean {
  if (state.running[sessionID] || state.queued[sessionID]) return true;
  if (state.activeIDs.includes(sessionID)) return true;
  return isPaneSession(sessionID) && liveForSession(sessionID).length > 0;
}

// ---- busy-send steering/queueing (QueueStrip) -----------------------------
//
// Sending while busy never fakes a transcript turn: the prompt is admitted as
// an engine-side inbox item and rendered in the QueueStrip until delivered.
// Lifecycle: sending (POST in flight) → tracked (inboxID known) → dropped
// when the item leaves the inbox (delivered or cancelled). The SSE events
// give instant signals; reconcileInbox on the 2s poll is the source of truth.

let pendingSendSeq = 0;

function setPending(sessionID: string, list: PendingSend[] | null) {
  const next = { ...state.pending };
  if (list && list.length > 0) next[sessionID] = list;
  else delete next[sessionID];
  setState({ pending: next });
}

function pushPendingSend(sessionID: string, entry: PendingSend) {
  setPending(sessionID, [...(state.pending[sessionID] ?? []), entry]);
}

function patchPendingSend(
  sessionID: string,
  key: string,
  patch: (entry: PendingSend) => PendingSend,
) {
  const list = state.pending[sessionID];
  if (!list?.some((p) => p.key === key)) return;
  let changed = false;
  const next = list.map((p) => {
    if (p.key !== key) return p;
    const patched = patch(p);
    if (patched !== p) changed = true;
    return patched;
  });
  // Compare-before-set: poll reconciliation runs every 2s and must not churn
  // subscribers with identical lists.
  if (!changed) return;
  setPending(sessionID, next);
}

/** Admit a busy-send: track it locally, POST it, stamp the returned item. */
async function admitWhileBusy(sessionID: string, text: string, delivery?: PromptDelivery) {
  const key = `pend_${Date.now().toString(36)}_${++pendingSendSeq}`;
  pushPendingSend(sessionID, {
    key,
    text,
    state: "sending",
    admittedAt: Date.now(),
    ...(delivery ? { delivery } : {}),
  });
  try {
    // Omitted delivery ⇒ engine default (busy ⇒ steer at next LLM call).
    // The response is the standard {data} envelope — the item lives in
    // `.data`. (Reading `info.id` off the envelope left every row "sending"
    // forever: no id to drop it by once the engine delivered the item.)
    const res = await api.prompt(sessionID, text, delivery);
    // The engine loop is running (or about to be): the wait loop may not be
    // armed if this busy state arose outside this tab — arm it; idempotent.
    ensureSessionWait(sessionID);
    const info = (res as { data?: InboxInfo } | undefined)?.data ?? (res as unknown as InboxInfo | undefined);
    if (info?.id) {
      patchPendingSend(sessionID, key, (p) => ({
        ...p,
        state: "tracked",
        inboxID: info.id,
        delivery: info.delivery ?? delivery,
      }));
    }
    // No id in the response: stay "sending" — reconcileInbox pairs the row
    // with the admitted item by text on the next poll tick.
  } catch (err) {
    removePendingSend(sessionID, key);
    recordSendError(sessionID, err);
    throw err;
  }
}

function removePendingSend(sessionID: string, key: string) {
  const list = state.pending[sessionID];
  if (!list?.some((p) => p.key === key)) return;
  setPending(sessionID, list.filter((p) => p.key !== key));
}

function inboxItemText(item: InboxInfo): string {
  const payload = item.payload as { text?: unknown } | undefined;
  return typeof payload?.text === "string" ? payload.text : "";
}

/**
 * True when an inbox item mirrors an optimistic IDLE send of ours: the
 * transcript already shows it as a msg_local_ turn and the engine delivers it
 * immediately — such admissions must NOT be duplicated into the strip.
 */
function isOwnIdleAdmission(sessionID: string, text: string): boolean {
  if (text === "" || sessionBusy(sessionID)) return false;
  return (state.messages[sessionID] ?? []).some(
    (m) => m.type === "user" && m.id.startsWith("msg_local_") && m.text === text,
  );
}

function samePendingList(a: PendingSend[], b: PendingSend[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i]!;
    return (
      p.key === q.key &&
      p.text === q.text &&
      p.state === q.state &&
      p.inboxID === q.inboxID &&
      p.delivery === q.delivery
    );
  });
}

/**
 * Reconcile the strip against GET /api/session/{id}/inbox:
 * 1. attach inboxIDs to still-"sending" rows by matching the admitted item's
 *    text (newest match wins, one-to-one — tracked rows claim theirs first);
 * 2. drop tracked rows whose id left the inbox (delivered or cancelled);
 * 3. hydrate rows for items this client didn't create (InboxPanel, another
 *    tab). Compare-before-set keeps repeat polls from churning state.
 *
 * `history` (ascending transcript, when the caller just fetched it) adds a
 * lag-proof delivery signal: the engine's inbox LISTING keeps a delivered
 * item for tens of seconds, but the delivered turn persists with the SAME id
 * as the inbox item — any row whose id (or, for never-tracked rows, whose
 * text past the admit time) shows up as a persisted user message was
 * delivered, full stop.
 */
// Exported for scripts/uitest/* regression harnesses (store-replay style).
export async function reconcileInbox(sessionID: string, history?: MessageInfo[]) {
  const res = await api.inboxList(sessionID);
  const server = res.data.filter((i) => i.type === "user");
  const serverIDs = new Set(server.map((i) => i.id));
  const before = state.pending[sessionID] ?? [];
  let list = [...before];

  // Delivered-detection from the transcript (see docblock above).
  let persistedUserIDs: Set<string> | null = null;
  let deliveredByTranscript = new Set<string>();
  if (history) {
    persistedUserIDs = new Set(
      history.filter((m) => m.type === "user" && !m.id.startsWith("msg_local_")).map((m) => m.id),
    );
    for (const p of before) {
      if (p.inboxID && persistedUserIDs.has(p.inboxID)) deliveredByTranscript.add(p.key);
      else if (!p.inboxID && p.admittedAt !== undefined) {
        // A row that never got its id (hung POST): match by text against
        // persisted user messages from around its admit time (60s skew).
        const hit = history.some(
          (m) =>
            m.type === "user" &&
            !m.id.startsWith("msg_local_") &&
            m.text === p.text &&
            m.time.created >= p.admittedAt! - 60_000,
        );
        if (hit) deliveredByTranscript.add(p.key);
      }
    }
  }

  const claimed = new Set(list.filter((p) => p.inboxID).map((p) => p.inboxID!));
  list = list.map((p) => {
    if (p.state !== "sending") return p;
    const candidates = server.filter((i) => !claimed.has(i.id) && inboxItemText(i) === p.text);
    if (candidates.length === 0) return p;
    const match = candidates.reduce((a, b) => (b.timeCreated >= a.timeCreated ? b : a));
    claimed.add(match.id);
    return { ...p, state: "tracked" as const, inboxID: match.id, delivery: match.delivery };
  });

  list = list.filter(
    (p) =>
      !deliveredByTranscript.has(p.key) &&
      !(p.state === "tracked" && p.inboxID && !serverIDs.has(p.inboxID)),
  );

  for (const item of [...server].sort((a, b) => a.timeCreated - b.timeCreated)) {
    if (list.some((p) => p.inboxID === item.id)) continue;
    // Already delivered (its turn is in the transcript) but the laggy listing
    // still returns it — hydrating it here would resurrect a dropped row.
    if (persistedUserIDs?.has(item.id)) continue;
    const text = inboxItemText(item);
    if (isOwnIdleAdmission(sessionID, text)) continue;
    list.push({
      key: `inbox_${item.id}`,
      text,
      state: "tracked",
      inboxID: item.id,
      delivery: item.delivery,
      admittedAt: Date.now(),
    });
  }

  // Merge in rows that appeared while the fetch was in flight (a fresh
  // admitWhileBusy push) — the stale snapshot must never erase them. But
  // NEVER resurrect rows this reconciliation just deliberately dropped
  // (delivered via transcript, or gone from the inbox): the merge used to
  // re-add them from live state, which made the poll unable to finish a
  // drop — only the SSE delivered-event could, so a missed event stuck the
  // strip row forever.
  const droppedKeys = new Set(deliveredByTranscript);
  for (const p of before) {
    if (p.state === "tracked" && p.inboxID && !serverIDs.has(p.inboxID)) droppedKeys.add(p.key);
  }
  const knownKeys = new Set(list.map((p) => p.key));
  for (const row of state.pending[sessionID] ?? []) {
    if (!knownKeys.has(row.key) && !droppedKeys.has(row.key)) list.push(row);
  }

  if (samePendingList(before, list)) return;
  setPending(sessionID, list);
}

/**
 * Insert an engine-known inbox item as a tracked row (event hydration).
 * Skipped when we already track the id, or when a "sending" row with the same
 * text exists — that's our own POST in flight whose response will pair up.
 */
function hydrateServerInboxItem(
  sessionID: string,
  item: { id: string; text: string; delivery?: PromptDelivery },
) {
  const list = state.pending[sessionID];
  if (list?.some((p) => p.inboxID === item.id)) return;
  if (list?.some((p) => p.state === "sending" && p.text === item.text)) return;
  if (isOwnIdleAdmission(sessionID, item.text)) return;
  pushPendingSend(sessionID, {
    key: `inbox_${item.id}`,
    text: item.text,
    state: "tracked",
    inboxID: item.id,
    delivery: item.delivery ?? "steer",
    admittedAt: Date.now(),
  });
}

/** Remove whichever pending row carries an inbox id (delivery/cancel event). */
function dropPendingByInboxID(inboxID: string) {
  let changed = false;
  const next = { ...state.pending };
  for (const [sid, list] of Object.entries(next)) {
    if (!list.some((p) => p.inboxID === inboxID)) continue;
    const filtered = list.filter((p) => p.inboxID !== inboxID);
    changed = true;
    if (filtered.length > 0) next[sid] = filtered;
    else delete next[sid];
  }
  if (changed) setState({ pending: next });
}

/**
 * The composer materializes the draft itself (resolveSendTarget) and then
 * sends to the REAL id — but sendCommand/sendShell/sendPromptWithFiles read
 * currentSessionID directly, so a draft id slipping through would hit the
 * API with "__draft__". These guards make that a loud no-op instead of a
 * bogus request; the composer's catch restores the typed text.
 */
function assertRealTarget(sid: string | null | undefined): sid is string {
  if (!sid || isDraftSession(sid)) throw new Error("send before materialize");
  return true;
}

export async function sendCommand(name: string, args?: string) {
  const sid = state.currentSessionID;
  if (!sid) return;
  assertRealTarget(sid);
  log("send", `command ${sid}: /${name} ${args ?? ""}`.trim());
  await ensureSessionModel(sid);
  commitRevertOptimistically(sid);
  appendOptimisticUserMessage(sid, args ? `/${name} ${args}` : `/${name}`);
  markPending(sid);
  try {
    await api.runCommand(sid, name, args);
  } catch (err) {
    clearPending(sid);
    recordSendError(sid, err);
    throw err;
  }
}

export async function sendShell(command: string) {
  const sid = state.currentSessionID;
  if (!sid) return;
  assertRealTarget(sid);
  log("send", `shell ${sid}: !${command.slice(0, 60)}`);
  await ensureSessionModel(sid);
  commitRevertOptimistically(sid);
  appendOptimisticUserMessage(sid, `!${command}`);
  markPending(sid);
  try {
    await api.sessionShell(sid, command);
  } catch (err) {
    clearPending(sid);
    recordSendError(sid, err);
    throw err;
  }
}

export async function sendPromptWithFiles(text: string, files: PromptFile[]) {
  const sid = state.currentSessionID;
  if (!sid) return;
  assertRealTarget(sid);
  log("send", `prompt+files ${sid}: ${text.slice(0, 80)}`);
  await ensureSessionModel(sid);
  commitRevertOptimistically(sid);
  appendOptimisticUserMessage(sid, text);
  markPending(sid);
  try {
    await api.promptWithFiles(sid, text, files);
    try {
      const { clearDraft } = await import("./lib/drafts");
      clearDraft(DRAFT_SESSION_ID);
    } catch {}
  } catch (err) {
    clearPending(sid);
    recordSendError(sid, err);
    throw err;
  }
}

/** Dismiss a rendered send failure. */
export function clearSendError(sessionID: string) {
  if (!state.sendErrors[sessionID]) return;
  const next = { ...state.sendErrors };
  delete next[sessionID];
  setState({ sendErrors: next });
}

// ---- QueueStrip row management --------------------------------------------

/** Remove a pending busy-send row; cancels the engine-side item if tracked. */
export function pendingDelete(sessionID: string, key: string) {
  const entry = state.pending[sessionID]?.find((p) => p.key === key);
  if (!entry) return;
  removePendingSend(sessionID, key);
  if (entry.state === "tracked" && entry.inboxID) {
    void api.inboxDelete(sessionID, entry.inboxID).catch((err) => {
      recordSendError(sessionID, err);
      // Cancel failed (e.g. delivered meanwhile) — put the row back so it
      // can't silently vanish; the poll drops it once it leaves the inbox.
      pushPendingSend(sessionID, entry);
    });
  }
}

/**
 * Flip a pending row between steer and queue. Optimistic locally, then
 * engine-side (steer wakes execution); reverted on error.
 */
export function pendingSetDelivery(sessionID: string, key: string, delivery: PromptDelivery) {
  const entry = state.pending[sessionID]?.find((p) => p.key === key);
  if (!entry || (entry.delivery ?? "steer") === delivery) return;
  const previous = entry.delivery ?? "steer";
  patchPendingSend(sessionID, key, (p) => ({ ...p, delivery }));
  const applied =
    entry.state === "tracked" && entry.inboxID
      ? delivery === "steer"
        ? api.inboxSteer(sessionID, entry.inboxID)
        : api.inboxQueue(sessionID, entry.inboxID)
      : Promise.resolve(); // still sending — nothing engine-side to flip yet
  void applied.catch((err) => {
    patchPendingSend(sessionID, key, (p) => ({ ...p, delivery: previous }));
    recordSendError(sessionID, err);
  });
}

/** "Send now": a parked queue row joins the run immediately via steer. */
export function pendingSendNow(sessionID: string, key: string) {
  const entry = state.pending[sessionID]?.find((p) => p.key === key);
  if (!entry || entry.state !== "tracked") return; // sending → nothing to wake yet
  if ((entry.delivery ?? "steer") === "queue") pendingSetDelivery(sessionID, key, "steer");
}

/**
 * Interrupt the current step AND resume with pending steering input while
 * queued prompts stay parked (`interrupt?continue=true`). The QueueStrip's
 * steer-group control — flushes steered rows without losing parked ones.
 */
export async function flushSteersNow(sessionID: string) {
  if (!sessionID || isDraftSession(sessionID)) return;
  disarmInterrupt();
  await api.interrupt(sessionID, true);
  // Reflect the stop immediately; events/poll reconciliation confirms after
  // (mirrors interrupt()).
  noteRunEnd(sessionID);
  setState({
    running: { ...state.running, [sessionID]: false },
    queued: { ...state.queued, [sessionID]: false },
  });
}

// ---- queue progression failsafe -------------------------------------------
//
// Queued items should be delivered at the next turn boundary, but some paths
// leave them parked across interrupts/idle without ever waking execution.
// When a turn TRULY ends (finishRun/settleRun), re-check after a short
// debounce and flip the FIRST still-present queue item to steer — steering
// wakes the session, the engine delivers it, and later items advance the same
// way on their own turn ends.

const QUEUE_DRAIN_DEBOUNCE_MS = 1800;
const queueDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleQueueDrain(sessionID: string) {
  if (isDraftSession(sessionID)) return;
  const existing = queueDrainTimers.get(sessionID);
  if (existing) clearTimeout(existing); // rapid end/start flapping re-arms only
  const timer = setTimeout(() => {
    queueDrainTimers.delete(sessionID);
    void drainQueuedPending(sessionID);
  }, QUEUE_DRAIN_DEBOUNCE_MS);
  queueDrainTimers.set(sessionID, timer);
}

async function drainQueuedPending(sessionID: string) {
  const first = (state.pending[sessionID] ?? []).find(
    (p) => p.delivery === "queue" && p.state === "tracked" && !!p.inboxID,
  );
  if (!first?.inboxID) return;
  // Guard: a new run already started (another steer woke it) — the engine is
  // delivering on its own schedule again, don't fight it.
  if (state.running[sessionID] || state.queued[sessionID]) return;
  try {
    const res = await api.inboxList(sessionID);
    if (!res.data.some((i) => i.id === first.inboxID)) return; // gone: delivered/cancelled
    if (state.running[sessionID] || state.queued[sessionID]) return;
    log("run", `drain ${sessionID}: steering parked queue item ${first.inboxID}`);
    patchPendingSend(sessionID, first.key, (p) => ({ ...p, delivery: "steer" }));
    await api.inboxSteer(sessionID, first.inboxID);
  } catch (err) {
    console.warn("queue drain failed:", err); // retried on the next turn end
  }
}

function appendOptimisticUserMessage(sid: string, text: string) {
  const optimistic: MessageInfo = {
    id: `msg_local_${Date.now()}`,
    type: "user",
    text,
    time: { created: Date.now() },
  };
  setState({
    messages: { ...state.messages, [sid]: [...(state.messages[sid] ?? []), optimistic] },
  });
}

/** Mark a session as awaiting its run start (covers provider cold-start gaps). */
function markPending(sid: string) {
  log("run", `pending ${sid} (awaiting run start)`);
  // A fresh prompt supersedes whatever went wrong in the previous run.
  clearRunNotices(sid);
  setState({ queued: { ...state.queued, [sid]: true } });
}

/**
 * The send failed before the engine ever queued the run — drop the waiting
 * state immediately so the UI can never stick in "Waiting…" until refresh
 * (the stuck-queued bug), and surface the failure inline.
 */
function clearPending(sid: string) {
  setState({ queued: { ...state.queued, [sid]: false } });
}

function recordSendError(sessionID: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  let detail: unknown;
  if (err && typeof err === "object" && "payload" in (err as Record<string, unknown>)) {
    detail = (err as { payload?: unknown }).payload;
  }
  const error: StructuredError =
    detail && typeof detail === "object" && "message" in (detail as Record<string, unknown>)
      ? {
          type: String((detail as { name?: unknown }).name ?? "error"),
          message: String((detail as { message?: unknown }).message ?? message),
        }
      : { type: "request-failed", message };
  console.warn("send failed:", error.type, error.message);
  setState({
    sendErrors: { ...state.sendErrors, [sessionID]: error },
  });
}

export async function activateSkill(id: string) {
  const sid = state.currentSessionID;
  if (!sid || isDraftSession(sid)) return;
  await api.activateSkill(sid, id);
  void refreshQueues();
}

export async function interrupt(sessionID?: string) {
  const sid = sessionID ?? state.currentSessionID;
  if (!sid || isDraftSession(sid)) return;
  disarmInterrupt();
  await api.interrupt(sid);
  // Reflect the stop immediately; events/poll reconciliation confirms after.
  noteRunEnd(sid);
  setState({
    running: { ...state.running, [sid]: false },
    queued: { ...state.queued, [sid]: false },
  });
}

/** How long the armed interrupt confirmation stays live before resetting. */
const INTERRUPT_ARM_MS = 2500;
let interruptArmTimer: ReturnType<typeof setTimeout> | null = null;

function disarmInterrupt() {
  if (interruptArmTimer) {
    clearTimeout(interruptArmTimer);
    interruptArmTimer = null;
  }
  if (state.interruptArmed) setState({ interruptArmed: false });
}

/**
 * The Esc handler behind "esc to interrupt": the first press only ARMS the
 * abort (the composer swaps its status line for a yellow confirm hint); a
 * second press inside INTERRUPT_ARM_MS actually interrupts. Left
 * unconfirmed, the hint self-reverts and the next Esc re-arms.
 */
export function requestInterrupt() {
  const sid = state.currentSessionID;
  if (!sid || !state.running[sid]) return;
  if (!state.interruptArmed) {
    if (interruptArmTimer) clearTimeout(interruptArmTimer);
    setState({ interruptArmed: true });
    interruptArmTimer = setTimeout(() => {
      interruptArmTimer = null;
      setState({ interruptArmed: false });
    }, INTERRUPT_ARM_MS);
    return;
  }
  void interrupt();
}

/**
 * TUI parity for the `ctrl+b` / `session.background` keybind: move this
 * session's synchronous (task-tool) subagents to background runs so they
 * keep working when the parent step ends.
 */
export async function backgroundSubagents(sessionID: string) {
  try {
    await api.sessionBackground(sessionID);
    debouncedRefreshSessions();
  } catch (err) {
    console.warn("backgroundSubagents failed:", err);
  }
}

export async function replyPermission(requestID: string, reply: "once" | "always" | "reject") {
  const req = state.permissions.find((p) => p.id === requestID);
  if (!req) return;
  try {
    await api.replyPermission(req.sessionID, requestID, reply);
  } finally {
    setState({ permissions: state.permissions.filter((p) => p.id !== requestID) });
  }
}

export async function replyForm(formID: string, answer: Record<string, string | number | boolean | string[]>) {
  const form = state.forms.find((f) => f.id === formID);
  if (!form) return;
  try {
    await api.replyForm(form.sessionID, formID, answer);
  } finally {
    setState({ forms: state.forms.filter((f) => f.id !== formID) });
  }
}

export async function cancelForm(formID: string) {
  const form = state.forms.find((f) => f.id === formID);
  if (!form) return;
  try {
    await api.cancelForm(form.sessionID, formID);
  } finally {
    setState({ forms: state.forms.filter((f) => f.id !== formID) });
  }
}

export async function replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<boolean> {
  // Native question request (newer engines) …
  const req = state.questions.find((q) => q.id === requestID);
  if (req) {
    try {
      await api.sessionQuestionReply(req.sessionID, requestID, answers);
    } catch (err) {
      log("panel", `question reply FAILED ${requestID}:`, err instanceof Error ? err.message : String(err));
      return false; // keep pending so the user can retry
    }
    setState({ questions: state.questions.filter((q) => q.id !== requestID) });
    return true;
  }
  // … or a question delivered as a form: answers map back to {"q0": value}.
  const form = state.forms.find((f) => f.id === requestID && isQuestionForm(f));
  if (!form) return false;
  const answer: Record<string, string | string[]> = {};
  form.fields.forEach((field, i) => {
    const picked = answers[i] ?? [];
    // The FIELD TYPE decides the wire shape (verified against the engine):
    // multiselect fields demand an ARRAY of option values (+ custom strings),
    // string fields demand ONE string. A wrong shape is rejected with
    // FormInvalidAnswerError and the request stays pending.
    const multi = field.type === "multiselect";
    answer[field.key] = multi ? picked : (picked[0] ?? "");
  });
  try {
    await api.replyForm(form.sessionID, form.id, answer);
  } catch (err) {
    // Keep the form pending so the user can retry — removing it here made a
    // failed submit look like a silent no-op (and hid the request forever).
    log("panel", `question reply FAILED ${form.id}:`, err instanceof Error ? err.message : String(err));
    return false;
  }
  setState({ forms: state.forms.filter((f) => f.id !== form.id) });
  return true;
}

export async function rejectQuestion(requestID: string) {
  const req = state.questions.find((q) => q.id === requestID);
  if (req) {
    try {
      await api.sessionQuestionReject(req.sessionID, requestID);
    } finally {
      setState({ questions: state.questions.filter((q) => q.id !== requestID) });
    }
    return;
  }
  const form = state.forms.find((f) => f.id === requestID && isQuestionForm(f));
  if (!form) return;
  await cancelForm(form.id);
}

/**
 * Esc / overlay-click / ✕ on the pending-request popup: cancel whichever
 * kind is on top. Permissions and questions are rejected, forms cancelled —
 * each is the "make it stop" reply for its surface.
 */
export function cancelPendingRequest(item: PendingRequest) {
  if (item.kind === "permission") void replyPermission(item.req.id, "reject");
  else if (item.kind === "question") void rejectQuestion(item.req.id);
  else void cancelForm(item.req.id);
}

// ---- optimistic draft session --------------------------------------------
//
// "New session" never creates anything server-side up front: it opens a
// client-only draft bound to a workspace. The real POST /api/session happens
// only when the first message is sent. Clicking New again while a draft is
// open re-binds it (never duplicates); opening a real session discards it.

/**
 * Open (or retarget) the draft. Idempotent by design: pressing New twice —
 * even in different workspaces — leaves exactly one draft, pointed at the
 * last requested workspace.
 */
export function startDraftSession(directory?: string | null) {
  // No explicit pick: inherit the workspace of the session being viewed, so
  // "New session" keeps you in place. Subagents may not carry a location of
  // their own — fall back to their parent's.
  const dirOf = (sid?: string | null): string | undefined => {
    if (!sid || isDraftSession(sid)) return undefined;
    const s = state.sessions.find((x) => x.id === sid) ?? state.sessionDetails[sid];
    return s?.location?.directory;
  };
  const current = state.currentSessionID && !isDraftSession(state.currentSessionID)
    ? state.sessions.find((x) => x.id === state.currentSessionID) ?? state.sessionDetails[state.currentSessionID]
    : undefined;
  const inherited =
    dirOf(state.currentSessionID) ?? (current?.parentID ? dirOf(current.parentID) : undefined);
  const workspace = directory ?? state.pendingWorkspace ?? state.draftWorkspace ?? inherited ?? null;
  const retarget = isDraftSession(state.currentSessionID);
  log("session", `draft ${retarget ? "retarget" : "open"} (workspace=${workspace ?? "default"})`);
  const nextPanes = withMainPaneSession(DRAFT_SESSION_ID);
  setState({
    currentSessionID: DRAFT_SESSION_ID,
    panes: nextPanes,
    focusedPane: MAIN_PANE,
    draftWorkspace: workspace,
    pendingWorkspace: null,
    // The previous main session just unmounted — keep only still-mounted streams.
    live: pruneLiveForPanes(nextPanes),
    // A fresh surface must not inherit uncommitted picks from the previous
    // session — they were never sent anywhere.
    ...(retarget ? {} : { pendingAgent: null, pendingModel: null }),
  });
  if (typeof window !== "undefined") updateSessionHistory(DRAFT_SESSION_ID, "push");
}

/** Sidebar highlight: mark a workspace as the next new session's target. */
export function setPendingWorkspace(directory: string | null) {
  setState({ pendingWorkspace: directory });
}

export function setHighlightMessage(sessionID: string, messageID: string, query?: string) {
  const normalized = (query ?? "").trim();
  // Re-navigating to the same message/query still bumps the tick so the
  // consumer can re-highlight (re-click on an already-selected hit).
  const same =
    state.highlightMessageID === messageID &&
    state.highlightSessionID === sessionID &&
    (state.highlightQuery ?? "") === normalized;
  setState({
    highlightSessionID: sessionID,
    highlightMessageID: messageID,
    highlightQuery: normalized || null,
    highlightTick: same ? state.highlightTick + 1 : state.highlightTick + 1,
  });
}

export function clearHighlightMessage() {
  setState({ highlightSessionID: null, highlightMessageID: null, highlightQuery: null });
}

/**
 * Turn the draft into a real session and deliver its first message.
 * Returns the created session id. Safe against double-invocation via the
 * materializing flag (the composer awaits this before its send).
 */
let materializing = false;

/**
 * Create a REAL server-side session bound to a workspace (model-pinned via
 * the resolved default). Shared by draft materialization and the split
 * picker's "start a new session" flow.
 */
export async function createRealSession(directory: string | null): Promise<string> {
  const model = await resolveDefaultModel();
  const res = await api.createSession({
    title: null,
    agent: null,
    model: model ?? null,
    location: directory ? { directory } : null,
  });
  const sid = res.data.id;
  if (model) log("model", `new session ${sid} -> ${model.providerID}/${model.id}`);
  await refreshSessions();
  await loadSessionDetail(sid);
  return sid;
}

export async function materializeDraft(text: string): Promise<string> {
  void text;
  if (!isDraftSession(state.currentSessionID) && state.draftWorkspace === null) {
    throw new Error("no draft session");
  }
  if (materializing) throw new Error("draft already materializing");
  materializing = true;
  try {
    const directory = state.draftWorkspace;
    log("session", `draft -> create (workspace=${directory ?? "default"})`);
    const sid = await createRealSession(directory);
    // Carry any optimistic user copy across so the transcript never blanks
    // between the draft surface and the real session.
    const draftMessages = state.messages[DRAFT_SESSION_ID] ?? [];
    seenEventIDs.clear();
    const nextPanes = withMainPaneSession(sid);
    setState({
      currentSessionID: sid,
      panes: nextPanes,
      focusedPane: MAIN_PANE,
      draftWorkspace: null,
      live: pruneLiveForPanes(nextPanes),
      messages: { ...state.messages, [sid]: draftMessages, [DRAFT_SESSION_ID]: [] },
    });
    rememberLastSession(sid);
    // /new-session replaces itself with the canonical URL — no extra history entry.
    if (typeof window !== "undefined") updateSessionHistory(sid, "replace");
    return sid;
  } finally {
    materializing = false;
  }
}

export async function newSession(options: { history?: "push" | "replace" } = {}) {
  // Legacy entry point (palette, ctrl+n): now opens the free draft instead
  // of creating a server-side session immediately.
  void options;
  startDraftSession(null);
}

export async function switchAgent(sessionID: string, agent: string) {
  // Dirty-detector switching: record locally, commit at send time. Switching
  // back before sending means nothing was ever persisted — no "Agent
  // switched to …" note, no engine round-trip.
  setState({ pendingAgent: agent });
  void sessionID;
}

export async function switchModel(sessionID: string, model: ModelRef) {
  // Same dirty-detector contract as switchAgent: local until the next send.
  // The pickers read the pending override first, then the session detail.
  setState({ pendingModel: model });
  void sessionID;
}

export async function renameSession(sessionID: string, title: string) {
  await api.renameSession(sessionID, title);
  await refreshSessions();
}

export async function forkSession(sessionID: string, boundary: ForkBoundary) {
  const res = await api.forkSession(sessionID, boundary);
  await refreshSessions();
  return res.data.id;
}

export async function exportSession(sessionID: string) {
  const res = await api.exportSession(sessionID);
  return res.data;
}

export async function compactSession(sessionID: string, delivery: CompactDelivery = "steer") {
  await api.compactSession(sessionID, delivery);
  await refreshSessions();
}

/**
 * TUI session.undo: abort a running engine run, stage a revert at the last
 * user message, and hand its text back to the composer (via `revertPrompt`).
 */
export async function undoSession(sessionID: string) {
  if (state.running[sessionID]) await interrupt(sessionID);
  const detail =
    state.sessionDetails[sessionID] ??
    (await api.getSession(sessionID).then((r) => r.data).catch(() => undefined));
  const revertMessageID = revertMarkerFor(state, sessionID, detail ?? undefined);
  // Consecutive undos walk backwards: start from the already-reverted view.
  const visible = applyRevertView(state.messages[sessionID] ?? [], revertMessageID);
  const lastUser = [...visible].reverse().find((m) => m.type === "user");
  if (!lastUser || lastUser.id.startsWith("msg_local_")) return;
  try {
    await api.revertStage(sessionID, lastUser.id);
    // Mirror the staged cut immediately — the SSE event confirms later.
    setRevertMarker(sessionID, lastUser.id);
  } finally {
    void loadSessionDetail(sessionID);
    void loadMessages(sessionID);
    debouncedRefreshSessions();
  }
  setState({ revertPrompt: lastUser.text ?? null });
}

/** TUI session.redo: revert forward to the next user message, or clear. */
export async function redoSession(sessionID: string) {
  const detail =
    state.sessionDetails[sessionID] ??
    (await api.getSession(sessionID).then((r) => r.data).catch(() => undefined));
  const revertMessageID = revertMarkerFor(state, sessionID, detail ?? undefined);
  if (!revertMessageID) return;
  try {
    // Full array, NOT the reverted view: redo steps FORWARD past the cut.
    const messages = state.messages[sessionID] ?? [];
    const nextUser = messages.find((m) => m.type === "user" && m.id > revertMessageID);
    if (!nextUser) {
      await api.revertClear(sessionID);
      setRevertMarker(sessionID, null);
    } else {
      await api.revertStage(sessionID, nextUser.id);
      setRevertMarker(sessionID, nextUser.id);
    }
  } finally {
    void loadSessionDetail(sessionID);
    void loadMessages(sessionID);
    debouncedRefreshSessions();
  }
}

export function startEditAtMessage(sessionID: string, messageID: string, text: string) {
  // Staged — not committed until the user actually sends. Accident-free: no history is truncated on click.
  setState({ pendingEdit: { sessionID, messageID, originalText: text ?? "" }, revertPrompt: text ?? null });
}

export function clearPendingEdit() {
  setState({ pendingEdit: null });
  // keep revertPrompt as-is if already consumed; otherwise clear it if it matches the pending edit
}

export async function commitPendingEdit(sessionID: string) {
  const pending = state.pendingEdit;
  if (!pending || pending.sessionID !== sessionID) return;
  if (state.running[sessionID]) await interrupt(sessionID);
  try {
    await api.revertStage(sessionID, pending.messageID);
  } finally {
    void loadSessionDetail(sessionID);
    void loadMessages(sessionID);
    debouncedRefreshSessions();
  }
  // The engine auto-commits a staged revert when the NEXT prompt arrives
  // (verified: `session.revert.committed` fires as the prompt is processed
  // and history shrinks to the post-revert turns). Model that locally RIGHT
  // NOW — cut the transcript at the edited message and point the marker at
  // it — so the imminent send can never race the async detail refresh.
  // This is the fix for the "old and new message both visible" / "where did
  // my response go" edit bug: commitRevertOptimistically (at send time) used
  // to read a STALE pre-stage detail, cut nothing, and a lagging staged
  // detail could then hide the new turn behind a view cut.
  const messages = state.messages[sessionID] ?? [];
  const idx = messages.findIndex((m) => m.id === pending.messageID);
  const truncated = idx === -1 ? messages : messages.slice(0, idx);
  setState({
    messages: { ...state.messages, [sessionID]: truncated },
    revertMarkers: { ...state.revertMarkers, [sessionID]: pending.messageID },
    pendingEdit: null,
  });
}

export async function editAtMessage(sessionID: string, messageID: string, text: string) {
  // Legacy immediate path (kept for compat) — now just stages.
  startEditAtMessage(sessionID, messageID, text);
}

export async function forkAtMessage(sessionID: string, messageID: string) {
  const res = await api.forkSession(sessionID, { type: "before", messageID });
  const newID = res.data.id;
  if (newID) await selectSession(newID);
  return newID;
}

export function toolStateFor(part: { state?: ToolState }): ToolState | undefined {
  return part.state;
}
