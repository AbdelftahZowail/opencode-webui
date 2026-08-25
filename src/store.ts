/**
 * Central store: sessions, messages, live assistant state, permission and
 * form queues. Driven by the /api/event stream plus REST fetches.
 */

import { useRef, useSyncExternalStore } from "react";
import { api, type CompactDelivery, type ForkBoundary, type PromptFile } from "./api/client";
import { connectEvents, type V2Event } from "./api/events";
import { log } from "./lib/log";
import type {
  AssistantMessage,
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
export interface QueuedQuestion extends QuestionRequest {
  seq: number;
}

export type PendingRequest =
  | { kind: "permission"; req: QueuedPermission }
  | { kind: "form"; req: QueuedForm }
  | { kind: "question"; req: QueuedQuestion };

let requestSeq = 0;
const nextRequestSeq = () => ++requestSeq;

/** Stamp incoming requests, reusing the seq of ids we already track. */
function stampSeq<T extends { id: string }>(current: { id: string; seq: number }[], incoming: T[]): (T & { seq: number })[] {
  const known = new Map(current.map((r) => [r.id, r.seq]));
  return incoming.map((r) => ({ ...r, seq: known.get(r.id) ?? nextRequestSeq() }));
}

/** Every unanswered permission/form/question across ALL sessions, FIFO. */
export function pendingRequests(s: State): PendingRequest[] {
  const all: PendingRequest[] = [
    ...s.permissions.map((req) => ({ kind: "permission" as const, req })),
    ...s.forms.map((req) => ({ kind: "form" as const, req })),
    ...s.questions.map((req) => ({ kind: "question" as const, req })),
  ];
  return all.sort((a, b) => a.req.seq - b.req.seq);
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

export interface State {
  connected: boolean;
  serviceOK: boolean;
  sessions: SessionInfo[];
  sessionsCursor: string | null;
  activeIDs: string[];
  messages: Record<string, MessageInfo[]>;
  sessionDetails: Record<string, SessionInfo>;
  live: LiveAssistant[];
  running: Record<string, boolean>;
  queued: Record<string, boolean>;
  permissions: QueuedPermission[];
  forms: QueuedForm[];
  questions: QueuedQuestion[];
  currentSessionID: string | null;
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
   * Transient run-problem notes per session (provider retries, failures,
   * interrupts), newest last, capped — rendered above the composer.
   */
  runNotices: Record<string, RunNotice[]>;
  /** Workspace targeted by the sidebar for the NEXT new session (highlight). */
  pendingWorkspace: string | null;
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
  shellPanelTick: 0,
  uiSignals: { models: 0, agents: 0, themes: 0, explorer: 0, runsDialog: 0, help: 0, variants: 0 },
  revertPrompt: null,
  runsPanelOpen: false,
  subagentComposerOpen: false,
  draftWorkspace: null,
  pendingAgent: null,
  pendingModel: null,
  sendErrors: {},
  runNotices: {},
  pendingWorkspace: null,
  interruptArmed: false,
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

export async function refreshSessions() {
  try {
    const res = await api.listSessions({ limit: Math.max(SESSION_PAGE, state.sessions.length + 1) });
    const active = await api.activeSessions();
    const running = { ...state.running };
    for (const id of Object.keys(active.data)) running[id] = true;
    const sessions = [...res.data].sort((a, b) => b.time.updated - a.time.updated);
    setState({ sessions, sessionsCursor: res.cursor.next, activeIDs: Object.keys(active.data), running });
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
  try {
    const [perms, forms, questions] = await Promise.all([
      api.pendingPermissions(),
      api.pendingForms(),
      api.questionRequestGet(),
    ]);
    setState({
      permissions: stampSeq(state.permissions, perms.data),
      forms: stampSeq(state.forms, forms.data),
      questions: stampSeq(state.questions, questions.data),
    });
  } catch (err) {
    console.warn("refreshQueues failed:", err);
  }
}

export async function loadMessages(sessionID: string) {
  if (isDraftSession(sessionID)) return; // nothing exists server-side yet
  const request = beginMessageRequest(sessionID);
  try {
    const res = await api.messages(sessionID, 100);
    if (messageRequests.get(sessionID) !== request) return;
    const history = [...res.data].reverse();
    log("load", `messages ${sessionID}: ${history.length} (limit 100)`);
    applyFetchedMessages(sessionID, history);
  } catch (err) {
    console.warn("loadMessages failed:", err);
  }
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

function liveAssistantFromPersisted(message: AssistantMessage): LiveAssistant {
  const ordinal = { text: 0, reasoning: 0 };
  const content = message.content.map((part): LiveContentPart => {
    if (part.type === "tool") return { type: "tool", tool: persistedToolToLive(part) };
    const currentOrdinal = ordinal[part.type]++;
    return { type: part.type, ordinal: currentOrdinal, text: part.text };
  });
  const assistant: LiveAssistant = {
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

function livePartKey(part: LiveContentPart): string {
  return part.type === "tool" ? `tool:${part.tool.id}` : `${part.type}:${part.ordinal}`;
}

function mergePersistedIntoLive(live: LiveAssistant, message: AssistantMessage): LiveAssistant {
  const persisted = liveAssistantFromPersisted(message);
  if (live.content.length === 0) return { ...persisted, id: live.id, started: live.started };

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

function hydrateLiveFromHistory(sessionID: string, history: MessageInfo[]) {
  if (state.currentSessionID !== sessionID) return;
  const persisted = new Map(
    history
      .filter((message): message is AssistantMessage => message.type === "assistant" && isUnfinishedAssistant(message))
      .map((message) => [message.id, message]),
  );
  let changed = false;
  const live = state.live.map((assistant) => {
    const message = persisted.get(assistant.id);
    if (!message) return assistant;
    const next = mergePersistedIntoLive(assistant, message);
    changed ||= next !== assistant;
    return next;
  });
  if (changed) setState({ live });
}

function liveOverlayIDs(history: MessageInfo[]): Set<string> {
  const fetched = new Map(history.map((message) => [message.id, message]));
  return new Set(
    state.live
      .filter((live) => {
        const persisted = fetched.get(live.id);
        return live.id !== "pending" && (!persisted || isUnfinishedAssistant(persisted));
      })
      .map((live) => live.id),
  );
}

function mergeFetchedMessages(sessionID: string, history: MessageInfo[]): MessageInfo[] {
  const existing = state.messages[sessionID] ?? [];
  const overlayIDs = liveOverlayIDs(history);
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
  if (state.currentSessionID !== sessionID) {
    setState({ messages: { ...state.messages, [sessionID]: merged } });
    return;
  }

  const fetchedByID = new Map(history.map((message) => [message.id, message]));
  const pending = state.live.find((live) => live.id === "pending");
  const pendingSettled = !!pending && history.some(
    (message) =>
      message.type === "assistant" &&
      message.time.completed !== undefined &&
      message.time.created >= pending.started - 5_000,
  );
  const settled = new Set(
    state.live
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
      ? state.live
          .filter((live) => live.id !== "pending" && !fetchedByID.has(live.id) && Date.now() - live.started > 30_000)
          .map((live) => live.id)
      : [],
  );
  const running = { ...state.running };
  if (pendingSettled) {
    delete running[sessionID];
    seenExecution.delete(sessionID);
  }
  setState({
    messages: { ...state.messages, [sessionID]: merged },
    live: state.live.filter(
      (live) => (live.id === "pending" ? !pendingSettled : !(settled.has(live.id) || ghosts.has(live.id))),
    ),
    running,
  });
}

function ensureLiveAssistant(id: string, started = Date.now()): LiveAssistant {
  const existing = state.live.find((m) => m.id === id);
  if (existing) return existing;
  const currentMessages = state.currentSessionID ? state.messages[state.currentSessionID] : undefined;
  const persisted = currentMessages?.find(
    (message): message is AssistantMessage =>
      message.id === id && message.type === "assistant" && isUnfinishedAssistant(message),
  );
  const fresh = persisted
    ? liveAssistantFromPersisted(persisted)
    : {
        id,
        content: [],
        text: "",
        reasoning: "",
        tools: new Map<string, LiveTool>(),
        started,
      };
  setState({
    live: [...state.live, fresh],
    ...(persisted && state.currentSessionID
      ? {
          messages: {
            ...state.messages,
            [state.currentSessionID]: currentMessages!.filter((message) => message.id !== id),
          },
        }
      : {}),
  });
  return fresh;
}

function hideUnfinishedHistory(id: string) {
  const sessionID = state.currentSessionID;
  if (!sessionID) return;
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
  setState({
    live: state.live.map((m) => {
      if (m.id !== id) return m;
      const next = { ...m, ...patch, tools: new Map(m.tools) };
      return patch.content ? withLiveContent(next, patch.content) : next;
    }),
  });
}

function ensureLiveContentPart(
  assistantID: string,
  type: "text" | "reasoning",
  ordinal: number,
): LiveContentPart | undefined {
  const assistant = ensureLiveAssistant(assistantID);
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
    return { ...part, text: mode === "append" ? part.text + text : text };
  });
  patchLiveAssistant(assistantID, { content });
}

function ensureLiveTool(assistantID: string, toolID: string, name?: string): LiveTool {
  const assistant = ensureLiveAssistant(assistantID);
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
  const updated = { ...tool, ...patch };
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
 * a "pending" placeholder. Once the first `session.step.started` reveals the
 * real assistant message id, re-key the placeholder to it so we never render
 * a duplicated "thinking…" block plus the real stream.
 */
function adoptPendingAssistant(id: string, patch: Pick<LiveAssistant, "agent" | "model">) {
  const pending = state.live.find(
    (m) => m.id === "pending" && m.text === "" && m.reasoning === "" && m.tools.size === 0,
  );
  if (pending) {
    setState({
      live: state.live
        .map((m) => (m.id === "pending" ? { ...m, ...patch, id } : m.id === id ? null : m))
        .filter((m): m is LiveAssistant => m !== null),
    });
    return;
  }
  ensureLiveAssistant(id);
  patchLiveAssistant(id, patch);
}

// ---- authoritative session detail & model pinning -----------------------

export async function loadSessionDetail(sessionID: string) {
  // The draft has no server-side session; fetching would just 404-log.
  if (isDraftSession(sessionID)) return;
  try {
    const res = await api.getSession(sessionID);
    setState({ sessionDetails: { ...state.sessionDetails, [sessionID]: res.data } });
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
  const liveIDs = state.live.filter((m) => m.id !== "pending").map((m) => m.id);
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

function pushRunNotice(sessionID: string, kind: RunNoticeKind, text: string, at = Date.now()) {
  if (!sessionID || isDraftSession(sessionID)) return;
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

function lastLiveAssistant(): LiveAssistant | undefined {
  return [...state.live].reverse().find((assistant) => assistant.id !== "pending");
}

function settleRun(sessionID: string) {
  // The run is over: scheduled-but-unfired retries can no longer happen.
  expireRetryNotices(sessionID);
  const running = { ...state.running };
  delete running[sessionID];
  seenExecution.delete(sessionID);
  setState({ running, queued: { ...state.queued, [sessionID]: false } });
  if (state.currentSessionID === sessionID) {
    if (state.live.some((assistant) => assistant.id === "pending")) {
      setState({ live: state.live.filter((assistant) => assistant.id !== "pending") });
    }
    void settleLiveMessages(sessionID);
  }
  debouncedRefreshSessions();
}

function finishRun(sessionID: string, type: string, error?: StructuredError) {
  const running = { ...state.running };
  delete running[sessionID];
  seenExecution.delete(sessionID);
  setState({ running, queued: { ...state.queued, [sessionID]: false } });

  if (state.currentSessionID === sessionID) {
    if (state.live.some((assistant) => assistant.id === "pending")) {
      setState({ live: state.live.filter((assistant) => assistant.id !== "pending") });
    }
    const active = lastLiveAssistant();
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
  }
  debouncedRefreshSessions();
}

export function handleEvent(event: V2Event) {
  const { type, data } = event;
  const current = state.currentSessionID;
  const eventSessionID = (data as { sessionID?: string }).sessionID;
  if (event.id && eventSessionID === current && seenEventIDs.has(event.id)) return;
  if (event.id && eventSessionID === current) {
    seenEventIDs.add(event.id);
  }

  const forCurrent = (sid?: string) => !!sid && sid === current;

  log("evt", type, `sid=${(data as { sessionID?: string }).sessionID ?? "-"}`,
    `current=${current ?? "-"}`, `mid=${(data as { assistantMessageID?: string }).assistantMessageID ?? "-"}`);

  if (current && LIVE_TYPES.has(type) && (data as { sessionID?: string }).sessionID !== current) {
    log("gate", `${type} for non-current session ${(data as { sessionID?: string }).sessionID} — skipped`);
  }

  switch (type) {
    case "session.created":
    case "session.renamed":
    case "session.deleted":
    case "session.moved":
    case "session.forked":
    case "session.usage.updated":
    case "session.revert.staged":
    case "session.revert.committed":
    case "session.revert.cleared":
      debouncedRefreshSessions();
      // A revert rewrites history — refresh the transcript of any session
      // whose messages we hold so removed turns disappear immediately.
      if (eventSessionID && (state.messages[eventSessionID]?.length ?? 0) > 0) {
        void loadMessages(eventSessionID);
      }
      if (type !== "session.usage.updated") void loadSessionDetail(data.sessionID);
      break;

    case "session.agent.selected":
    case "session.model.selected":
      debouncedRefreshSessions();
      void loadSessionDetail(data.sessionID);
      break;

    case "session.inbox.enqueued":
      if (forCurrent(data.sessionID)) {
        log("run", `queued ${data.sessionID}`);
        setState({ queued: { ...state.queued, [data.sessionID]: true } });
      }
      break;

    case "session.inbox.delivered":
      break;

    case "session.error":
      // Run-level failure the step/execution events don't carry (e.g.
      // provider auth errors). Surface it inline; clear any waiting state —
      // the run is over even if no terminal execution event follows.
      if (data.sessionID) {
        const err = (data as { error?: StructuredError }).error;
        if (err) {
          setState({
            sendErrors: {
              ...state.sendErrors,
              [data.sessionID]: { type: err.type ?? "error", message: err.message, status: err.status },
            },
          });
          pushRunNotice(data.sessionID, "error", `${err.type}: ${err.message}`, event.created);
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
      if (forCurrent(data.sessionID)) ensureLiveAssistant(data.assistantMessageID ?? "pending", event.created);
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
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.error) {
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
      // A clean finish leaves nothing to account for; a failure or an
      // interrupt is exactly what the strip exists to show.
      if (type === "session.execution.succeeded") {
        clearRunNotices(data.sessionID);
      } else {
        expireRetryNotices(data.sessionID);
        if (type === "session.execution.failed") {
          const err = data.error;
          pushRunNotice(
            data.sessionID,
            "failed",
            err ? `${err.type}: ${err.message}` : "Run failed",
            event.created,
          );
        } else {
          const reason = (data as { reason?: string }).reason;
          pushRunNotice(
            data.sessionID,
            "interrupted",
            `Run interrupted${reason && reason !== "user" ? ` (${reason})` : ""}`,
            event.created,
          );
        }
      }
      finishRun(data.sessionID, type, data.error);
      break;
    }

    case "session.step.started":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        adoptPendingAssistant(data.assistantMessageID, { agent: data.agent, model: data.model });
        ensureLiveAssistant(data.assistantMessageID, event.created);
        hideUnfinishedHistory(data.assistantMessageID);
        patchLiveAssistant(data.assistantMessageID, {
          agent: data.agent,
          model: data.model,
          finish: undefined,
          error: undefined,
          completed: undefined,
        });
        if (!seenExecution.has(data.sessionID) && !state.running[data.sessionID]) {
          log("run", `live via step.started ${data.sessionID}`);
          setState({
            running: { ...state.running, [data.sessionID]: true },
            queued: { ...state.queued, [data.sessionID]: false },
          });
        }
      }
      break;

    case "session.step.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
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
      if (data.sessionID && data.error) {
        pushRunNotice(data.sessionID, "failed", `${data.error.type}: ${data.error.message}`, event.created);
      }
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
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
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.assistantMessageID, "text", data.ordinal ?? 0);
        if (state.queued[data.sessionID]) setState({ queued: { ...state.queued, [data.sessionID]: false } });
      }
      break;
    case "session.text.delta":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.assistantMessageID, "text", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "text", data.ordinal ?? 0, data.delta ?? "", "append");
      }
      break;
    case "session.text.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.assistantMessageID, "text", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "text", data.ordinal ?? 0, data.text ?? "", "replace");
      }
      break;

    case "session.reasoning.started":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.assistantMessageID, "reasoning", data.ordinal ?? 0);
      }
      break;
    case "session.reasoning.delta":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.assistantMessageID, "reasoning", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "reasoning", data.ordinal ?? 0, data.delta ?? "", "append");
      }
      break;
    case "session.reasoning.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveContentPart(data.assistantMessageID, "reasoning", data.ordinal ?? 0);
        patchLiveContentPart(data.assistantMessageID, "reasoning", data.ordinal ?? 0, data.text ?? "", "replace");
      }
      break;

    case "session.tool.input.started":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        ensureLiveTool(data.assistantMessageID, data.id, data.name);
      }
      break;
    case "session.tool.input.delta":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        ensureLiveTool(data.assistantMessageID, data.id);
        const tool = state.live.find((m) => m.id === data.assistantMessageID)?.tools.get(data.id);
        patchLiveTool(data.assistantMessageID, data.id, { inputText: (tool?.inputText ?? "") + (data.delta ?? "") });
      }
      break;
    case "session.tool.input.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        const tool = ensureLiveTool(data.assistantMessageID, data.id);
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
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        const tool = ensureLiveTool(data.assistantMessageID, data.id);
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
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        ensureLiveTool(data.assistantMessageID, data.id);
        patchLiveTool(data.assistantMessageID, data.id, { metadata: data.metadata });
      }
      break;
    case "session.tool.success":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        patchLiveTool(data.assistantMessageID, data.id, {
          status: "completed",
          content: (data.content as ToolContent[]) ?? undefined,
          metadata: data.metadata,
          executed: data.executed,
          completed: event.created,
        });
      }
      break;
    case "session.tool.failed":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        patchLiveTool(data.assistantMessageID, data.id, {
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

    default:
      if (type.startsWith("form.") || type.startsWith("question.") || type === "session.skill.activated") {
        void refreshQueues();
      }
      break;
  }
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
      for (const item of events) handleEvent(item);
    });
  }, 16);
}

export function startStore() {
  if (started) return;
  started = true;
  log("boot", "start");
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
    syncLocation();
  }
  void refreshSessions();
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
    },
  }).then(() => setState({ connected: false }));
  startPolling();
}

// ---- live poll fallback -------------------------------------------------
//
// The SSE stream is the primary channel and streams character deltas. As a
// safety net (events have proven flaky over the proxy in some runs), a light
// poll reconciles the transcript with the service while a session is running
// or has live content, so a finished answer can NEVER be lost behind a silent
// SSE hiccup.

const POLL_MS = 2000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void pollOnce(), POLL_MS);
}

async function reconcileSession(sid: string, historyDesc: MessageInfo[]) {
  if (state.currentSessionID !== sid) return;
  const history = [...historyDesc].reverse();
  applyFetchedMessages(sid, history);
}

async function pollOnce() {
  if (pollInFlight) return;
  const sids = new Set<string>();
  for (const [sid, on] of Object.entries(state.running)) if (on) sids.add(sid);
  if (
    state.currentSessionID &&
    !isDraftSession(state.currentSessionID) &&
    (state.live.length > 0 || state.queued[state.currentSessionID])
  ) {
    sids.add(state.currentSessionID);
  }
  if (sids.size === 0) return;

  pollInFlight = true;
  try {
    for (const sid of sids) {
      const request = beginMessageRequest(sid);
      try {
        const res = await api.messages(sid, 50);
        if (messageRequests.get(sid) !== request) continue;
        const before = state.messages[sid]?.length ?? 0;
        await reconcileSession(sid, res.data);
        const after = state.messages[sid]?.length ?? 0;
        if (after !== before) log("poll", `reconcile ${sid}: ${before} -> ${after} messages`);
      } catch {
        /* transient; try again next tick */
      }
    }
  } finally {
    pollInFlight = false;
  }
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
 * TUI messagesBeforeRevert: with a staged revert the transcript is cut at
 * the revert message (exclusive) — the service still returns full history.
 */
export function applyRevertView<T extends { id: string }>(messages: T[], revertMessageID?: string): T[] {
  if (!revertMessageID) return messages;
  const index = messages.findIndex((m) => m.id === revertMessageID);
  return index === -1 ? messages : messages.slice(0, index);
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
    setState({ currentSessionID: DRAFT_SESSION_ID, live: [], subagentComposerOpen: false });
    return;
  }
  setState({
    currentSessionID: sessionID,
    live: [],
    subagentComposerOpen: false,
    queued: sessionID ? { ...state.queued, [sessionID]: false } : state.queued,
  });
  if (sessionID) {
    rememberLastSession(sessionID);
    // Navigating to a real session discards the pending draft — the draft
    // only exists while it IS the current surface.
    if (state.draftWorkspace !== null) setState({ draftWorkspace: null });
    if (!state.sessions.some((s) => s.id === sessionID) && !state.sessionDetails[sessionID]) {
      void loadSessionDetail(sessionID);
    }
    await loadMessages(sessionID);
  } else if (state.draftWorkspace !== null) {
    setState({ draftWorkspace: null });
  }
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

/**
 * Send a prompt to an explicit session — child/subagent sessions included.
 * Sessions are uniform, so messaging a child is a normal prompt against its
 * id; optimistic copies and the pending flag are keyed by that id.
 */
export async function sendPromptTo(sessionID: string, text: string) {
  log("send", `prompt ${sessionID}: ${text.slice(0, 80)}`);
  await ensureSessionModel(sessionID);
  appendOptimisticUserMessage(sessionID, text);
  markPending(sessionID);
  try {
    await api.prompt(sessionID, text);
  } catch (err) {
    clearPending(sessionID);
    recordSendError(sessionID, err);
    throw err;
  }
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
  appendOptimisticUserMessage(sid, text);
  markPending(sid);
  try {
    await api.promptWithFiles(sid, text, files);
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

export async function interrupt() {
  const sid = state.currentSessionID;
  if (!sid || isDraftSession(sid)) return;
  disarmInterrupt();
  await api.interrupt(sid);
  // Reflect the stop immediately; events/poll reconciliation confirms after.
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

export async function replyQuestion(requestID: string, answers: QuestionAnswer[]) {
  const req = state.questions.find((q) => q.id === requestID);
  if (!req) return;
  try {
    await api.sessionQuestionReply(req.sessionID, requestID, answers);
  } finally {
    setState({ questions: state.questions.filter((q) => q.id !== requestID) });
  }
}

export async function rejectQuestion(requestID: string) {
  const req = state.questions.find((q) => q.id === requestID);
  if (!req) return;
  try {
    await api.sessionQuestionReject(req.sessionID, requestID);
  } finally {
    setState({ questions: state.questions.filter((q) => q.id !== requestID) });
  }
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
  setState({
    currentSessionID: DRAFT_SESSION_ID,
    draftWorkspace: workspace,
    pendingWorkspace: null,
    live: [],
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

/**
 * Turn the draft into a real session and deliver its first message.
 * Returns the created session id. Safe against double-invocation via the
 * materializing flag (the composer awaits this before its send).
 */
let materializing = false;

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
    // Carry any optimistic user copy across so the transcript never blanks
    // between the draft surface and the real session.
    const draftMessages = state.messages[DRAFT_SESSION_ID] ?? [];
    seenEventIDs.clear();
    setState({
      currentSessionID: sid,
      draftWorkspace: null,
      live: [],
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
  if (state.running[sessionID]) await interrupt();
  const detail =
    state.sessionDetails[sessionID] ??
    (await api.getSession(sessionID).then((r) => r.data).catch(() => undefined));
  const revertMessageID = (detail as { revert?: { messageID?: string } } | undefined)?.revert?.messageID;
  // Consecutive undos walk backwards: start from the already-reverted view.
  const visible = applyRevertView(state.messages[sessionID] ?? [], revertMessageID);
  const lastUser = [...visible].reverse().find((m) => m.type === "user");
  if (!lastUser || lastUser.id.startsWith("msg_local_")) return;
  try {
    await api.revertStage(sessionID, lastUser.id);
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
  const revertMessageID = (detail as { revert?: { messageID?: string } } | undefined)?.revert?.messageID;
  if (!revertMessageID) return;
  try {
    const messages = state.messages[sessionID] ?? [];
    const nextUser = messages.find((m) => m.type === "user" && m.id > revertMessageID);
    if (!nextUser) await api.revertClear(sessionID);
    else await api.revertStage(sessionID, nextUser.id);
  } finally {
    void loadSessionDetail(sessionID);
    void loadMessages(sessionID);
    debouncedRefreshSessions();
  }
}

export function toolStateFor(part: { state?: ToolState }): ToolState | undefined {
  return part.state;
}
