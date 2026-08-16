/**
 * Central store: sessions, messages, live assistant state, permission and
 * form queues. Driven by the /api/event stream plus REST fetches.
 */

import { useRef, useSyncExternalStore } from "react";
import { api, type CompactDelivery, type ForkBoundary, type PromptFile } from "./api/client";
import { connectEvents, type V2Event } from "./api/events";
import { log } from "./lib/log";
import type {
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
}

export interface LiveAssistant {
  id: string;
  agent?: string;
  model?: ModelRef;
  text: string;
  reasoning: string;
  tools: Map<string, LiveTool>;
  finish?: string;
  cost?: number;
  error?: StructuredError;
  started: number;
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

function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}
function emit() {
  for (const fn of listeners) fn();
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

function updateSessionHistory(sessionID: string | null) {
  if (typeof window === "undefined") return;
  const next = sessionID ? sessionHref(sessionID) : "/";
  if (window.location.pathname === next && !window.location.search && !window.location.hash) return;
  window.history.pushState({}, "", next);
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
  try {
    const res = await api.messages(sessionID, 100);
    const history = [...res.data].reverse();
    log("load", `messages ${sessionID}: ${history.length} (limit 100)`);
    if (state.currentSessionID === sessionID) {
      // Keep live assistants whose persisted copy isn't in the fetched history
      // yet (the write may lag execution end); drop the "pending" placeholder.
      // This prevents a finicky refresh race from hiding a just-finished answer.
      setState({
        messages: { ...state.messages, [sessionID]: history },
        live: state.live.filter((m) => m.id !== "pending" && !history.some((h) => h.id === m.id)),
      });
    } else {
      setState({ messages: { ...state.messages, [sessionID]: history } });
    }
  } catch (err) {
    console.warn("loadMessages failed:", err);
  }
}

// ---- live message helpers ----------------------------------------------

function ensureLiveAssistant(id: string): LiveAssistant {
  const existing = state.live.find((m) => m.id === id);
  if (existing) return existing;
  const fresh: LiveAssistant = { id, text: "", reasoning: "", tools: new Map(), started: Date.now() };
  setState({ live: [...state.live, fresh] });
  return fresh;
}

function patchLiveAssistant(id: string, patch: Partial<LiveAssistant>) {
  setState({
    live: state.live.map((m) => (m.id === id ? { ...m, ...patch, tools: new Map(m.tools) } : m)),
  });
}

function ensureLiveTool(assistantID: string, toolID: string, name?: string): LiveTool {
  const assistant = ensureLiveAssistant(assistantID);
  const existing = assistant.tools.get(toolID);
  if (existing) return existing;
  const tool: LiveTool = { id: toolID, name: name ?? "tool", inputText: "", status: "streaming" };
  const tools = new Map(assistant.tools);
  tools.set(toolID, tool);
  setState({ live: state.live.map((m) => (m.id === assistantID ? { ...m, tools } : m)) });
  return tool;
}

function patchLiveTool(assistantID: string, toolID: string, patch: Partial<LiveTool>) {
  const assistant = state.live.find((m) => m.id === assistantID);
  if (!assistant) return;
  const tool = assistant.tools.get(toolID);
  if (!tool) return;
  const tools = new Map(assistant.tools);
  tools.set(toolID, { ...tool, ...patch });
  setState({ live: state.live.map((m) => (m.id === assistantID ? { ...m, tools } : m)) });
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
  return { type: "tool", id: t.id, name: t.name, state, time: { created: Date.now() } };
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

export function handleEvent(event: V2Event) {
  const { type, data } = event;
  const current = state.currentSessionID;
  const forCurrent = (sid?: string) => !!sid && sid === current;

  log("evt", type, `sid=${(data as { sessionID?: string }).sessionID ?? "-"}`,
    `current=${current ?? "-"}`, `mid=${(data as { assistantMessageID?: string }).assistantMessageID ?? "-"}`);

  const LIVE_TYPES = new Set([
    "session.execution.started", "session.execution.succeeded", "session.execution.failed",
    "session.execution.interrupted", "session.step.started", "session.step.ended",
    "session.text.started", "session.text.delta", "session.text.ended",
    "session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended",
    "session.tool.called", "session.tool.input.started", "session.tool.input.delta",
    "session.tool.input.ended", "session.tool.success", "session.tool.failed",
    "session.retry.scheduled",
  ]);
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
      // delivered may precede execution.started; keep `queued` until a real
      // run begins so the user still sees feedback during the handoff.
      break;

    case "session.execution.started":
      seenExecution.add(data.sessionID);
      log("run", `started ${data.sessionID}`);
      setState({
        running: { ...state.running, [data.sessionID]: true },
        queued: { ...state.queued, [data.sessionID]: false },
      });
      if (forCurrent(data.sessionID)) ensureLiveAssistant(data.assistantMessageID ?? "pending");
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
    case "session.execution.interrupted": {
      const running = { ...state.running };
      delete running[data.sessionID];
      seenExecution.delete(data.sessionID);
      log("run", `finished ${data.sessionID} (${type})`);
      setState({
        running,
        queued: { ...state.queued, [data.sessionID]: false },
      });
      if (forCurrent(data.sessionID)) {
        const real = state.live.filter((m) => m.id !== "pending");
        if (real.length !== state.live.length) setState({ live: real });
      }
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        patchLiveAssistant(data.assistantMessageID, {
          finish: type === "session.execution.succeeded" ? "stop" : "interrupted",
          error: data.error,
        });
      }
      if (forCurrent(data.sessionID)) void settleLiveMessages(data.sessionID);
      debouncedRefreshSessions();
      break;
    }

    case "session.step.started":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        adoptPendingAssistant(data.assistantMessageID, { agent: data.agent, model: data.model });
        // No execution.started in this environment? A step starting means the
        // queued message is now live — promote it to "running" so the UI
        // engages (working badge, Stop, composer state).
        if (state.queued[data.sessionID]) {
          log("run", `live via step.started ${data.sessionID}`);
          setState({
            running: { ...state.running, [data.sessionID]: true },
            queued: { ...state.queued, [data.sessionID]: false },
          });
        }
      }
      break;

    case "session.text.started":
      if (forCurrent(data.sessionID) && data.assistantMessageID && state.queued[data.sessionID]) {
        // safety net: any live text means the run has started
        setState({ queued: { ...state.queued, [data.sessionID]: false } });
      }
      break;

    case "session.step.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        patchLiveAssistant(data.assistantMessageID, {
          finish: data.finish,
          cost: data.cost,
        });
        if (!seenExecution.has(data.sessionID) && data.finish === "stop") {
          const running = { ...state.running };
          delete running[data.sessionID];
          setState({ running });
        }
      }
      break;

    case "session.text.started":
      if (forCurrent(data.sessionID) && data.assistantMessageID) ensureLiveAssistant(data.assistantMessageID);
      break;
    case "session.text.delta":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveAssistant(data.assistantMessageID);
        patchLiveAssistant(data.assistantMessageID, { text: (state.live.find((m) => m.id === data.assistantMessageID)?.text ?? "") + (data.delta ?? "") });
      }
      break;
    case "session.text.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        patchLiveAssistant(data.assistantMessageID, { text: data.text ?? "" });
      }
      break;

    case "session.reasoning.started":
      if (forCurrent(data.sessionID) && data.assistantMessageID) ensureLiveAssistant(data.assistantMessageID);
      break;
    case "session.reasoning.delta":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        ensureLiveAssistant(data.assistantMessageID);
        const base = state.live.find((m) => m.id === data.assistantMessageID)?.reasoning ?? "";
        patchLiveAssistant(data.assistantMessageID, { reasoning: base + (data.delta ?? "") });
      }
      break;
    case "session.reasoning.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID) {
        patchLiveAssistant(data.assistantMessageID, { reasoning: data.text ?? "" });
      }
      break;

    case "session.tool.called":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        const tool = ensureLiveTool(data.assistantMessageID, data.id);
        if (data.input !== undefined) {
          patchLiveTool(data.assistantMessageID, data.id, {
            input: data.input,
            inputText: JSON.stringify(data.input),
            status: tool.status === "streaming" ? "running" : tool.status,
          });
        }
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
        patchLiveTool(data.assistantMessageID, data.id, {
          inputText: (tool?.inputText ?? "") + (data.delta ?? ""),
        });
      }
      break;
    case "session.tool.input.ended":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        const tool = ensureLiveTool(data.assistantMessageID, data.id);
        let parsed: unknown = undefined;
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
    case "session.tool.success":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        patchLiveTool(data.assistantMessageID, data.id, {
          status: "completed",
          content: (data.content as ToolContent[]) ?? undefined,
          metadata: data.metadata,
        });
      }
      break;
    case "session.tool.failed":
      if (forCurrent(data.sessionID) && data.assistantMessageID && data.id) {
        patchLiveTool(data.assistantMessageID, data.id, {
          status: "error",
          error: data.error,
          content: (data.content as ToolContent[]) ?? undefined,
        });
      }
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
      setState({
        questions: state.questions.filter((q) => q.id !== (data as { requestID?: string }).requestID),
      });
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

export function startStore() {
  if (started) return;
  started = true;
  log("boot", "start");
  if (typeof window !== "undefined") {
    window.addEventListener("popstate", () => {
      void selectSession(sessionIDFromLocation(), { history: "none" });
    });
    const initialSessionID = sessionIDFromLocation();
    if (initialSessionID) void selectSession(initialSessionID, { history: "none" });
  }
  void refreshSessions();
  void refreshQueues();
  void api
    .health()
    .then((h) => setState({ serviceOK: h.ok }))
    .catch(() => setState({ serviceOK: false }));
  void connectEvents((env) => handleEvent(env.data), {
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

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void pollOnce(), POLL_MS);
}

async function reconcileSession(sid: string, historyDesc: MessageInfo[]) {
  if (state.currentSessionID !== sid) return;
  const history = [...historyDesc].reverse();
  const fetchedIDs = new Set(history.map((h) => h.id));
  const existing = state.messages[sid] ?? [];
  const present = new Set(existing.map((m) => m.id));
  const merged = [...existing];
  for (const h of history) {
    if (!present.has(h.id) && !h.id.startsWith("msg_local_")) {
      merged.push(h);
      present.add(h.id);
    }
  }
  // Drop optimistic local user messages once the persisted copy with the
  // same text shows up in fetched history.
  const realUserTexts = new Set(history.filter((h) => h.type === "user").map((h) => h.text));
  const clean = merged.filter(
    (m) => !(m.id.startsWith("msg_local_") && m.type === "user" && realUserTexts.has(m.text)),
  );
  const liveAfter = state.live.filter((m) => m.id === "pending" || !fetchedIDs.has(m.id));
  const messagesChanged =
    clean.length !== state.messages[sid]?.length ||
    clean.some((m, i) => m !== (state.messages[sid] ?? [])[i]);
  const liveChanged = liveAfter.length !== state.live.length;
  if (messagesChanged || liveChanged) {
    setState({
      messages: messagesChanged ? { ...state.messages, [sid]: clean } : state.messages,
      live: liveChanged ? liveAfter : state.live,
    });
  }
}

async function pollOnce() {
  const sids = new Set<string>();
  for (const [sid, on] of Object.entries(state.running)) if (on) sids.add(sid);
  if (state.currentSessionID) sids.add(state.currentSessionID);
  if (sids.size === 0) return;
  for (const sid of sids) {
    try {
      const res = await api.messages(sid, 50);
      const before = state.messages[sid]?.length ?? 0;
      await reconcileSession(sid, res.data);
      const after = state.messages[sid]?.length ?? 0;
      if (after !== before) log("poll", `reconcile ${sid}: ${before} -> ${after} messages`);
    } catch {
      /* transient; try again next tick */
    }
  }
}

// ---- actions ------------------------------------------------------------

export async function selectSession(
  sessionID: string | null,
  options: { history?: "push" | "none" } = {},
) {
  log("session", "select", sessionID ?? "null");
  if (options.history !== "none") updateSessionHistory(sessionID);
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

export async function newSession() {
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
  await selectSession(sid);
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
