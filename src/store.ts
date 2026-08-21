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
  permissions: PermissionRequest[];
  forms: FormInfo[];
  questions: QuestionRequest[];
  currentSessionID: string | null;
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
  const next = sessionID ? sessionHref(sessionID) : "/";
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
    setState({ permissions: perms.data, forms: forms.data, questions: questions.data });
  } catch (err) {
    console.warn("refreshQueues failed:", err);
  }
}

export async function loadMessages(sessionID: string) {
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
  const running = { ...state.running };
  if (pendingSettled) {
    delete running[sessionID];
    seenExecution.delete(sessionID);
  }
  setState({
    messages: { ...state.messages, [sessionID]: merged },
    live: state.live.filter((live) => (live.id === "pending" ? !pendingSettled : !settled.has(live.id))),
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

async function ensureSessionModel(sessionID: string) {
  if (state.sessions.find((s) => s.id === sessionID)?.model) return;
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
      debouncedRefreshSessions();
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

    case "session.execution.started":
      seenExecution.add(data.sessionID);
      log("run", `started ${data.sessionID}`);
      setState({
        running: { ...state.running, [data.sessionID]: true },
        queued: { ...state.queued, [data.sessionID]: false },
      });
      if (forCurrent(data.sessionID)) ensureLiveAssistant(data.assistantMessageID ?? "pending", event.created);
      break;

    case "session.retry.scheduled":
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

    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      log("run", `finished ${data.sessionID} (${type})`);
      finishRun(data.sessionID, type, data.error);
      break;

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
            { id: data.id!, sessionID: data.sessionID, action: data.action ?? "", resources: (data.resources as string[]) ?? [] },
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
            { id: data.id!, sessionID: data.sessionID, questions: payload.questions ?? [], tool: payload.tool },
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
        void newSession({ history: "replace" });
      } else {
        void selectSession(null, { history: "none" });
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
  if (state.currentSessionID && (state.live.length > 0 || state.queued[state.currentSessionID])) {
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

export async function selectSession(
  sessionID: string | null,
  options: { history?: "push" | "replace" | "none" } = {},
) {
  log("session", "select", sessionID ?? "null");
  if (options.history !== "none") updateSessionHistory(sessionID, options.history ?? "push");
  // A reconnect can replay events that were already handled before navigation;
  // the newly selected session must be allowed to hydrate from that replay.
  seenEventIDs.clear();
  setState({
    currentSessionID: sessionID,
    live: [],
    queued: sessionID ? { ...state.queued, [sessionID]: false } : state.queued,
  });
  if (sessionID) {
    if (!state.sessions.some((s) => s.id === sessionID) && !state.sessionDetails[sessionID]) {
      void loadSessionDetail(sessionID);
    }
    await loadMessages(sessionID);
  }
}

export async function sendPrompt(text: string) {
  const sid = state.currentSessionID;
  if (!sid) return;
  log("send", `prompt ${sid}: ${text.slice(0, 80)}`);
  await ensureSessionModel(sid);
  appendOptimisticUserMessage(sid, text);
  markPending(sid);
  await api.prompt(sid, text);
}

export async function sendCommand(name: string, args?: string) {
  const sid = state.currentSessionID;
  if (!sid) return;
  log("send", `command ${sid}: /${name} ${args ?? ""}`.trim());
  await ensureSessionModel(sid);
  appendOptimisticUserMessage(sid, args ? `/${name} ${args}` : `/${name}`);
  markPending(sid);
  await api.runCommand(sid, name, args);
}

export async function sendShell(command: string) {
  const sid = state.currentSessionID;
  if (!sid) return;
  log("send", `shell ${sid}: !${command.slice(0, 60)}`);
  await ensureSessionModel(sid);
  appendOptimisticUserMessage(sid, `!${command}`);
  markPending(sid);
  await api.sessionShell(sid, command);
}

export async function sendPromptWithFiles(text: string, files: PromptFile[]) {
  const sid = state.currentSessionID;
  if (!sid) return;
  log("send", `prompt+files ${sid}: ${text.slice(0, 80)}`);
  await ensureSessionModel(sid);
  appendOptimisticUserMessage(sid, text);
  markPending(sid);
  await api.promptWithFiles(sid, text, files);
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
  setState({ queued: { ...state.queued, [sid]: true } });
}

export async function activateSkill(id: string) {
  const sid = state.currentSessionID;
  if (!sid) return;
  await api.activateSkill(sid, id);
  void refreshQueues();
}

export async function interrupt() {
  const sid = state.currentSessionID;
  if (!sid) return;
  await api.interrupt(sid);
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

export async function newSession(options: { history?: "push" | "replace" } = {}) {
  log("session", "newSession create");
  const res = await api.createSession({ title: null, agent: null, model: null, location: null });
  const sid = res.data.id;
  if (!res.data.model) {
    // The service resolves its own default model at run time unless pinned.
    // Pin to the UI default so what the picker shows is what actually runs.
    const m = await resolveDefaultModel();
    if (m) {
      await api.switchModel(sid, m).catch(() => undefined);
      log("model", `new session ${sid} pinned -> ${m.providerID}/${m.id}`);
    }
  }
  await refreshSessions();
  await loadSessionDetail(sid);
  await selectSession(sid, { history: options.history ?? "push" });
  return sid;
}

export async function switchAgent(sessionID: string, agent: string) {
  await api.switchAgent(sessionID, agent);
  debouncedRefreshSessions();
}

export async function switchModel(sessionID: string, model: ModelRef) {
  await api.switchModel(sessionID, model);
  debouncedRefreshSessions();
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

export function toolStateFor(part: { state?: ToolState }): ToolState | undefined {
  return part.state;
}
