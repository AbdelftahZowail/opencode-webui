/**
 * Minimal typed client for the opencode v2 HTTP API.
 * All requests go through the same-origin /api path (proxied by the Bun
 * server, which attaches service auth). Streaming endpoints are in
 * events.ts.
 */

import type {
  AgentInfo,
  CommandInfo,
  FormDetail,
  FormInfo,
  FormState,
  InboxInfo,
  MessageInfo,
  MessagesResponse,
  MessageTypeFilter,
  ModelInfo,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  PermissionRuleset,
  PermissionSavedInfo,
  QuestionAnswer,
  QuestionRequest,
  SessionInfo,
  SessionsResponse,
  SkillInfo,
} from "./types";
import type { SessionStatsInfo } from "../lib/stats";
import { fireHooks } from "../extensions/hooks";

export type ForkBoundary =
  | { type: "before"; messageID: string }
  | { type: "through" };

export type CompactDelivery = "steer" | "queue";

/** Prompt/inbox delivery: steer joins the active run, queue waits for the next turn. */
export type PromptDelivery = CompactDelivery;

export interface SessionExportData {
  info: SessionInfo;
  messages: MessageInfo[];
}

/**
 * `Vcs.Mode` — `working` (uncommitted), `branch` (merge-base of the current
 * branch), `committed` (merge-base → HEAD). `committed` was missing from this
 * type even though the contract always allowed it (parity R0.3/R7).
 */
export type VcsMode = "working" | "branch" | "committed";

export interface VcsLocation {
  directory?: string | null;
  workspace?: string | null;
}

export interface VcsFileStatus {
  file: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export interface VcsDiffFile {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export interface VcsBase {
  name: string;
  ref: string;
  source: "reflog" | "default";
}

/**
 * `FileDiff.Info` — returned by `GET /api/session/{id}/diff`. Structurally
 * identical to `VcsDiffFile` today (the engine inlines the same shape for
 * both); kept as its own name because the two endpoints are independent and
 * may diverge. Session diffs are TURN-scoped, not working-tree-scoped.
 */
export type FileDiffInfo = VcsDiffFile;

/**
 * What a turn changed. `from`/`to` are user message ids (`^msg_`); omitting
 * both diffs the newest user message's turn. `context` is the unchanged
 * lines around each hunk — omit for full-file patches.
 */
export interface SessionDiffOptions {
  from?: string | null;
  to?: string | null;
  context?: string | null;
}

export interface ShellInfo {
  id: string;
  status: "running" | "exited" | "timeout" | "killed";
  command: string;
  cwd: string;
  shell: string;
  file: string;
  pid?: number;
  exit?: number;
  metadata: Record<string, unknown>;
  time: { started: number; completed?: number };
}

export interface ShellOutputData {
  output: string;
  cursor: number;
  size: number;
  truncated: boolean;
}

export interface PtyInfo {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited";
  pid: number;
  exitCode?: number;
}

export interface PtyConnectToken {
  ticket: string;
  expires_in: number;
}

function vcsQuery(
  location?: VcsLocation,
  extra?: Record<string, string | number | null | undefined>,
): string {
  const params = new URLSearchParams();
  if (location) {
    if (location.directory != null) params.set("location[directory]", location.directory);
    if (location.workspace != null) params.set("location[workspace]", location.workspace);
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value != null) params.set(key, String(value));
    }
  }
  return params.toString();
}

/** Best human-readable error for a failed response (engine JSON or plain). */
async function responseError(res: Response): Promise<string> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    /* non-JSON error body */
  }
  return message;
}

/**
 * HTTP status of a thrown API error. `responseError` prefers the engine's JSON
 * `message`, which does NOT contain the status — so engine-drift fallbacks must
 * read the status off the error, never by sniffing the message text (a JSON
 * 404 whose message is "Form not found: …" silently defeated a message sniff).
 * `request()` attaches it; the message-prefix check is a fallback only.
 */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number") return status;
  const m = err instanceof Error ? err.message.match(/^(\d{3})/) : null;
  return m ? Number(m[1]) : undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  // Attach the status so a caller can branch on route/body drift.
  if (!res.ok) throw Object.assign(new Error(await responseError(res)), { status: res.status });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Flip an inbox item's delivery (`steer`/`queue`). The engine consolidated the
 * old `POST .../inbox/{id}/{steer|queue}` sub-routes into
 * `PATCH .../inbox/{id}` with `{delivery}`; fall back to the legacy sub-route
 * on 404/405 so an older engine still flips.
 */
async function setInboxDelivery(
  sessionID: string,
  inboxID: string,
  delivery: PromptDelivery,
): Promise<unknown> {
  try {
    return await patch<unknown>(`/api/session/${sessionID}/inbox/${inboxID}`, { delivery });
  } catch (err) {
    const status = statusOf(err);
    if (status !== 404 && status !== 405) throw err;
    return request<unknown>(`/api/session/${sessionID}/inbox/${inboxID}/${delivery}`, {
      method: "POST",
    });
  }
}

/**
 * MCP write/action call. The routes moved from `/api/mcp/{server}*` to
 * `/api/experimental/mcp/{server}*` (only the read routes stayed). Try the
 * current namespace first and fall back to the legacy path on 404/405.
 */
async function mcpRequest(
  server: string,
  method: "PUT" | "DELETE" | "POST",
  location: VcsLocation | undefined,
  body?: unknown,
  action?: "connect" | "disconnect",
): Promise<unknown> {
  const name = encodeURIComponent(server);
  const suffix = action ? `/${action}` : "";
  const q = vcsQuery(location);
  const init: RequestInit =
    body !== undefined
      ? {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : { method };
  try {
    return await request<unknown>(`/api/experimental/mcp/${name}${suffix}?${q}`, init);
  } catch (err) {
    const status = statusOf(err);
    if (status !== 404 && status !== 405) throw err;
    return request<unknown>(`/api/mcp/${name}${suffix}?${q}`, init);
  }
}

export interface FsEntry {
  path: string;
  type: "file" | "directory";
}

export interface LocationInfo {
  directory: string;
  workspaceID?: string;
  project?: { id: string; directory: string; canonical: string };
}

export interface FsFindResponse {
  location: LocationInfo;
  data: FsEntry[];
}

export interface FsListResponse {
  location: LocationInfo;
  data: FsEntry[];
}

export interface ProjectInfo {
  id: string;
  canonical: string;
  directory?: string | null;
  vcs?: string | null;
  icon?: { color?: string } | null;
  time?: { created: number; updated: number } | null;
  sandboxes?: unknown[] | null;
}

export interface PromptFile {
  uri: string;
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
}

// ---- providers / integrations / mcp / plugins / config / server (Q4) ----

export interface ProviderInfo {
  id: string;
  canonical?: string;
  integrationID?: string;
  name: string;
  /** `Provider.Info.activation` — replaced the old `disabled` flag. */
  activation?: "auto" | "enabled" | "disabled";
  package: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface IntegrationKeyMethod {
  type: "key";
  label?: string;
  form?: unknown;
}

export interface IntegrationEnvMethod {
  type: "env";
  names: string[];
}

export interface IntegrationOAuthMethod {
  id: string;
  type: "oauth";
  label: string;
  form?: unknown;
}

export interface IntegrationCommandMethod {
  id: string;
  type: "command";
  label: string;
  command: string[];
}

export type IntegrationMethod =
  | IntegrationKeyMethod
  | IntegrationEnvMethod
  | IntegrationOAuthMethod
  | IntegrationCommandMethod;

export type ConnectionInfo =
  | { type: "credential"; id: string; label: string }
  | { type: "env"; name: string };

export interface IntegrationInfo {
  id: string;
  name: string;
  methods: IntegrationMethod[];
  connections: ConnectionInfo[];
}

export interface IntegrationAttempt {
  attemptID: string;
  url: string;
  instructions?: string;
  mode?: "auto" | "code";
  time: { created: number; expires: number };
}

export type AttemptStatus = "pending" | "complete" | "failed" | "expired";

export interface AttemptStatusInfo {
  status: AttemptStatus;
  message?: string;
  time?: { created: number; expires: number };
}

export type McpStatus =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "disabled" }
  | { status: "needs_auth" }
  | { status: "failed"; error: string };

export interface McpServer {
  name: string;
  status: McpStatus;
  integrationID?: string;
}

export interface McpResource {
  server: string;
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  server: string;
  name: string;
  uriTemplate: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceCatalog {
  resources: McpResource[];
  templates: McpResourceTemplate[];
}

export interface McpTimeout {
  startup?: number;
  catalog?: number;
  execution?: number;
}

export interface McpLocalConfig {
  type: "local";
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  disabled?: boolean;
  codemode?: boolean;
  timeout?: McpTimeout;
}

export interface McpRemoteConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth?: unknown;
  disabled?: boolean;
  codemode?: boolean;
  timeout?: McpTimeout;
}

export type McpServerConfig = McpLocalConfig | McpRemoteConfig;

/** `Plugin.Source` — where a plugin came from, with update info for packages. */
export type PluginSource =
  | { type: "builtin" }
  | { type: "package"; target: string; version?: string; outdated?: true; updating?: true }
  | { type: "local"; path: string }
  | { type: "sdk" };

export interface PluginFeatures {
  server?: true;
  tui?: true;
  rpc?: true;
}

export type PluginState =
  | { status: "active" }
  | { status: "failed"; error: string; ref?: string };

/** `Plugin.Info` — note `id` is optional in the schema; `source` is the key. */
export interface PluginInfo {
  id?: string;
  source: PluginSource;
  features: PluginFeatures;
  state: PluginState;
}

/** `GET|POST /api/plugin/check` result. */
export interface PluginCheckResult {
  location: LocationInfo;
  data: PluginInfo[];
}

// ---- worktrees ----------------------------------------------------------
//
// Location-scoped (NOT project-scoped — the old `{projectID}` routes were
// removed upstream). A worktree is a managed parallel checkout: `list`
// discovers via the location's registered strategy, `create` runs the
// project's setup script, `remove` uses the strategy recorded at create time.

export interface WorktreeDirectory {
  directory: string;
  strategy?: string;
}

export interface WorktreeInfo {
  directory: string;
}

/**
 * `Worktree.CreateInput` — all fields optional; the engine fills from the
 * location's registered strategy and its directory defaults.
 */
export interface WorktreeCreateInput {
  strategy?: string;
  from?: string;
  branch?: string;
  directory?: string;
  name?: string;
}

/** `Worktree.RemoveInput` — `force` is required by the schema. */
export interface WorktreeRemoveInput {
  directory: string;
  force: boolean;
}

// ---- config preferences -------------------------------------------------

/**
 * `Config.Patch` — the live global-config patch (`PATCH /api/experimental/config`).
 * The old read route (`GET /api/config/preferences`) is gone and `websearch` is
 * no longer patchable; only the shell preference remains (`null` clears it).
 */
export interface ConfigPreferencesPatch {
  shell?: string | null;
}

/** `ConfigShell.Option` — a shell the engine can run commands with. */
export interface ConfigShellOption {
  path: string;
  name: string;
  acceptable: boolean;
}

export interface WebSearchProvider {
  id: string;
  name: string;
}

export interface WebSearchResult {
  url: string;
  title?: string;
  content?: string;
  time?: { published?: number };
}

export interface WebSearchResponse {
  providerID: string;
  results: WebSearchResult[];
}

export interface ConfigInfo {
  [key: string]: unknown;
}

export type ConfigEntry =
  | { type: "document"; path?: string; info: ConfigInfo }
  | { type: "file"; path: string }
  | { type: "directory"; path: string }
  | { type: "agents"; path: string }
  | { type: "claude"; path: string };

/** `ServerInfo` — from `GET /api/info` (which replaced `GET /api/server`). */
export interface ServerInfo {
  version: string;
  pid: number;
  urls: string[];
  paths: { tmp: string };
}

export interface GenerateResponse {
  data: { text: string };
}

export interface ReferenceInfo {
  name: string;
  path: string;
  description?: string;
  hidden?: boolean;
  source: unknown;
}

// ---- serve/security settings (proxy-owned; server/config.ts) ----------------
export type WebuiAuthMode = "password" | "none";

export interface WebuiConfigShape {
  host: string;
  port: number;
  auth: WebuiAuthMode;
  passwordSet: boolean;
  allowedHosts: string[];
  trustProxy: boolean;
  autostart: boolean;
  publicUrl: string | null;
}

export interface WebuiExposure {
  level: "ok" | "warn" | "danger";
  exposed: boolean;
  unauthenticated: boolean;
  message: string | null;
}

export interface WebuiSettings {
  file: WebuiConfigShape;
  effective: WebuiConfigShape & { sources: Record<string, "env" | "file" | "default"> };
  runtime: {
    host: string;
    port: number;
    auth: WebuiAuthMode;
    version: string;
    configPath: string;
    /** Repo checkout: two-port dev topology (Vite + internal proxy). */
    dev: boolean;
    vitePort: number | null;
  };
  exposure: WebuiExposure;
  restartRequired: boolean;
  /** config key -> the environment variable overriding it. */
  envPinned: Record<string, string>;
}

export type WebuiConfigPatch = Partial<{
  host: string;
  port: number;
  auth: WebuiAuthMode;
  password: string;
  clearPassword: boolean;
  allowedHosts: string[];
  trustProxy: boolean;
  autostart: boolean;
  publicUrl: string | null;
}>;

export type WebuiUpdateResult =
  | { ok: true; settings: WebuiSettings }
  | { ok: false; needConfirm: true; exposure: WebuiExposure }
  | { ok: false; error: string };

/**
 * `GET /api/webui/update/check` — proxy-local update probe (the engine has no
 * update route; the proxy fetches the npm registry). `channel` distinguishes a
 * repo checkout (`dev`), a compiled binary, and a published install, because the
 * install path behaves differently per channel (see server/setup.ts runUpdate).
 * `unavailable` means the probe could not reach the registry — a soft state the
 * UI renders, never an error (the route still answers HTTP 200).
 */
export interface WebuiUpdateCheck {
  current: string;
  latest?: string | null;
  updateAvailable: boolean;
  channel: "dev" | "binary" | "published";
  unavailable?: boolean;
  error?: string;
}

const apiRaw = {
  health: () => request<{ ok: boolean; service?: string; error?: string }>("/api/webui/status"),

  // serve/security settings — GET, save (with a danger-confirm path), restart
  webuiSettings: () => request<WebuiSettings>("/api/webui/settings"),
  webuiSettingsUpdate: async (patch: WebuiConfigPatch, confirm = false): Promise<WebuiUpdateResult> => {
    const res = await fetch("/api/webui/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...patch, confirm }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 409 && body.needConfirm === true) {
      return { ok: false, needConfirm: true, exposure: body.exposure as WebuiExposure };
    }
    if (!res.ok) return { ok: false, error: String(body.error ?? `${res.status} ${res.statusText}`) };
    return { ok: true, settings: body as unknown as WebuiSettings };
  },
  webuiRestart: () =>
    request<{ ok: boolean; restarting: boolean }>("/api/webui/settings/restart", { method: "POST" }),

  /**
   * Proxy-local update check (no engine route): the proxy asks the npm
   * registry for the latest published version and reports the running
   * `channel`. A failed probe resolves with `unavailable: true`, not a throw.
   */
  checkWebuiUpdate: () => request<WebuiUpdateCheck>("/api/webui/update/check"),
  /**
   * Proxy-local update install: spawns the detached `update` CLI and returns
   * immediately. The running version only changes on the published channel —
   * a dev checkout / compiled binary logs and no-ops (server/setup.ts
   * runUpdate). Apply with the existing restart route when ready.
   */
  installWebuiUpdate: () =>
    request<{ ok: boolean; updating: boolean }>("/api/webui/update", { method: "POST" }),

  // sessions
  /**
   * Proxy-local catch-up: the recorder's ring buffer of recent session
   * events (see server/index.ts). `since` trims to after the given event id.
   */
  webuiReplay: (sessionID: string, since?: string) =>
    request<{ data: Array<{ id: string; created: number; type: string; data: unknown }> }>(
      `/api/webui/replay?sessionID=${encodeURIComponent(sessionID)}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
    ),

  listSessions: (opts: { limit?: number; cursor?: string | null; search?: string } = {}) => {
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit ?? 50));
    if (opts.cursor) {
      params.set("cursor", opts.cursor);
    } else {
      params.set("order", "desc");
      if (opts.search) params.set("search", opts.search);
    }
    return request<SessionsResponse>(`/api/session?${params.toString()}`);
  },
  activeSessions: () =>
    request<{ data: Record<string, { type: "running" }> }>("/api/session/active"),
  /**
   * `POST /api/experimental/session/{sessionID}/wait` — engine-native
   * long-poll that resolves when the session's agent loop goes idle. Returns
   * the RAW status on purpose: 204 = idle truth, 404 = session gone, 503 =
   * unavailable, -1 = network error/abort. Only 204 is an idle signal —
   * everything else is "unknown", so nothing here throws.
   *
   * The route moved under `/api/experimental/`; older engines only serve
   * `/api/session/{id}/wait`, so a 404 falls back to the legacy path (both
   * report "session gone" as 404, so the fallback never masks a real signal).
   */
  sessionWait: (sessionID: string, signal?: AbortSignal): Promise<number> => {
    const id = encodeURIComponent(sessionID);
    return fetch(`/api/experimental/session/${id}/wait`, { method: "POST", signal }).then(
      (r) =>
        r.status === 404
          ? fetch(`/api/session/${id}/wait`, { method: "POST", signal }).then(
              (r2) => r2.status,
              () => -1,
            )
          : r.status,
      () => -1,
    );
  },
  /**
   * GET /api/experimental/session/{sessionID}/log?follow=false — cursor
   * bootstrap for the engine's DURABLE per-session event log (spike-verified:
   * durable across restarts; head cursor works; `follow=true` streams
   * nothing on beta-18684, so this is plumbing for a later swap, not a
   * catch-up channel yet). Returns the head sequence, or null when the
   * endpoint is unavailable.
   */
  sessionLogHead: async (sessionID: string): Promise<number | null> => {
    try {
      const res = await fetch(
        `/api/experimental/session/${encodeURIComponent(sessionID)}/log?follow=false`,
      );
      if (!res.ok) return null;
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim()) as { type?: string; seq?: number };
          if (evt.type === "log.synced" && typeof evt.seq === "number") return evt.seq;
        } catch {
          /* skip malformed line */
        }
      }
      return null;
    } catch {
      return null;
    }
  },
  createSession: (body: {
    title?: string | null;
    agent?: string | null;
    model?: ModelRef | null;
    location?: { directory: string } | null;
    /** Session-scoped permission rules, evaluated after the agent's. */
    permissions?: PermissionRuleset | null;
  }) =>
    request<{ data: SessionInfo }>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  getSession: (sessionID: string) =>
    request<{ data: SessionInfo }>(`/api/session/${sessionID}`),
  /**
   * Rename a session. The engine moved this onto the session resource itself:
   * `POST .../rename` is gone and `PATCH /api/session/{id}` now carries
   * `{title}`. Try the current shape first and fall back to the legacy route on
   * 404/405 so an older engine still renames.
   */
  renameSession: async (sessionID: string, title: string) => {
    try {
      return await patch<unknown>(`/api/session/${sessionID}`, { title });
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return post<unknown>(`/api/session/${sessionID}/rename`, { title });
    }
  },
  /**
   * Fork a session. The boundary body was RENAMED upstream: the live engine
   * takes `{ before: messageID | null }` (`null` forks the whole session),
   * where the old contract took `{ boundary: ForkBoundary }`. The engine
   * ignores an unknown key, so the old shape did not error — it silently
   * forked the wrong boundary. Send the current shape first and fall back to
   * the legacy body on 400/422 (`empty_session` is a 400 on both shapes, so
   * the fallback surfaces the same message — it does not mask real errors).
   */
  forkSession: async (sessionID: string, boundary: ForkBoundary) => {
    const id = encodeURIComponent(sessionID);
    const before = boundary.type === "before" ? boundary.messageID : null;
    try {
      return await post<{ data: SessionInfo }>(`/api/session/${id}/fork`, { before });
    } catch (err) {
      const status = statusOf(err);
      if (status !== 400 && status !== 422) throw err;
      return post<{ data: SessionInfo }>(`/api/session/${id}/fork`, { boundary });
    }
  },
  /**
   * The whole transcript in one request.
   *
   * The engine moved this route under `/api/experimental/` — verified live:
   * `/api/session/{id}/export` 404s while `/api/experimental/session/{id}/export`
   * answers 200 with the same `SessionTransfer.Data` payload. Older engines
   * only serve the legacy path, so try the current one first and fall back on
   * 404 ONLY (a 401/500 is a real failure and must not be masked by a probe).
   */
  exportSession: async (sessionID: string, sanitize = false) => {
    const id = encodeURIComponent(sessionID);
    const query = `?sanitize=${sanitize}`;
    const res = await fetch(`/api/experimental/session/${id}/export${query}`);
    if (res.ok) return (await res.json()) as { data: SessionExportData };
    if (res.status !== 404) throw new Error(await responseError(res));
    return request<{ data: SessionExportData }>(`/api/session/${id}/export${query}`);
  },
  /**
   * `GET /api/experimental/session/stats` — the engine's aggregate stats over a
   * range (defaults to year-to-date when the caller passes nothing). The route
   * moved under `/api/experimental/`; a 404 falls back to the legacy path (both
   * answer 404 only when genuinely unavailable, so the fallback masks nothing).
   */
  sessionStats: async (opts?: { from?: string; to?: string; project?: string; timezone?: string; tools?: "none" | "summary" | "detail" }): Promise<SessionStatsInfo> => {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    if (opts?.project) params.set("project", opts.project);
    if (opts?.timezone) params.set("timezone", opts.timezone);
    if (opts?.tools) params.set("tools", opts.tools);
    const q = params.toString();
    const unwrap = async (path: string) => (await request<{ data: SessionStatsInfo }>(path)).data;
    try { return await unwrap(`/api/experimental/session/stats${q ? `?${q}` : ""}`); }
    catch (err) { if (statusOf(err) !== 404) throw err; return unwrap(`/api/session/stats${q ? `?${q}` : ""}`); }
  },
  compactSession: (sessionID: string, delivery: CompactDelivery = "steer") =>
    request<{ data: unknown }>(`/api/session/${sessionID}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: null, delivery }),
    }),
  deleteSession: (sessionID: string) =>
    request<unknown>(`/api/session/${sessionID}`, { method: "DELETE" }),
  switchAgent: (sessionID: string, agent: string) =>
    request<unknown>(`/api/session/${sessionID}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent }),
    }),
  switchModel: (sessionID: string, model: ModelRef) =>
    request<unknown>(`/api/session/${sessionID}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }),
  interrupt: (sessionID: string, continueRun?: boolean) => {
    // `resume=true` interrupts the current step AND resumes with pending
    // steering input while queued prompts stay parked; omitted = plain abort.
    // The query key was RENAMED upstream (`continue` → `resume`), and an
    // unknown query key is silently ignored — so a `continue`-only request
    // does a plain interrupt on the current engine. Send BOTH keys: the engine
    // ignores the one it doesn't know, and one request works on either
    // generation.
    const query =
      continueRun === undefined ? "" : `?continue=${continueRun}&resume=${continueRun}`;
    return request<{ interrupted?: boolean }>(
      `/api/session/${sessionID}/interrupt${query}`,
      { method: "POST" },
    );
  },
  /** Move session to another workspace/directory. */
  moveSession: (sessionID: string, directory: string) =>
    request<unknown>(`/api/session/${sessionID}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory }),
    }),
  /** Stage a revert at a message (undo messages + file changes up to it). */
  revertStage: (sessionID: string, messageID: string) =>
    request<unknown>(`/api/session/${sessionID}/revert/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageID }),
    }),
  /**
   * Clear the staged/current revert (redo past the revert point). The route
   * changed `POST …/revert/clear` → `DELETE /api/session/{id}/revert`; fall
   * back to the legacy path on 404/405.
   */
  revertClear: async (sessionID: string) => {
    try {
      return await request<unknown>(`/api/session/${sessionID}/revert`, { method: "DELETE" });
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return request<unknown>(`/api/session/${sessionID}/revert/clear`, { method: "POST" });
    }
  },
  /** Commit the staged revert. */
  revertCommit: (sessionID: string) =>
    request<unknown>(`/api/session/${sessionID}/revert/commit`, { method: "POST" }),
  /** Background the session's synchronous (task-tool) subagents. */
  sessionBackground: (sessionID: string) =>
    request<unknown>(`/api/session/${sessionID}/background`, { method: "POST" }),
  /**
   * Structured per-file diffs of the files ONE TURN changed. A turn runs from
   * the first prompt after the session went idle until its next idle marker,
   * so prompts steered in while busy belong to the same turn. Unlike
   * `vcsDiff` (working tree / branch base), this is turn-scoped.
   */
  sessionDiff: (sessionID: string, opts: SessionDiffOptions = {}) => {
    const params = new URLSearchParams();
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    if (opts.context) params.set("context", opts.context);
    const qs = params.toString();
    return request<{ data: FileDiffInfo[] }>(
      `/api/session/${sessionID}/diff${qs ? `?${qs}` : ""}`,
    );
  },
  /**
   * Replace the session-scoped permission rules. Rules evaluate after the
   * agent's rules and the LAST match wins.
   *
   * The dedicated `PUT .../permission/rules` route was removed upstream — the
   * ruleset now rides `PATCH /api/session/{id}` as `{permissions}` (returns
   * 204). Try the current shape first; fall back to the legacy route on
   * 404/405 so an older engine still accepts the write.
   */
  sessionPermissionRules: async (sessionID: string, permissions: PermissionRuleset) => {
    try {
      return await patch<unknown>(`/api/session/${sessionID}`, { permissions });
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return request<unknown>(`/api/session/${sessionID}/permission/rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions }),
      });
    }
  },
  sessionShell: (sessionID: string, command: string) =>
    request<unknown>(`/api/session/${sessionID}/shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), command }),
    }),

  // messaging
  messages: (sessionID: string, limit = 100, type?: MessageTypeFilter) => {
    const params = new URLSearchParams({ limit: String(limit), order: "desc" });
    if (type) params.set("type", type);
    return request<MessagesResponse>(`/api/session/${sessionID}/message?${params.toString()}`);
  },
  messagesWithCursor: (sessionID: string, limit = 100, cursor?: string | null, type?: MessageTypeFilter) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    else params.set("order", "desc");
    // The filter must be re-sent on every page or the cursor walks a
    // different result set than the one it was created against.
    if (type) params.set("type", type);
    return request<MessagesResponse>(`/api/session/${sessionID}/message?${params.toString()}`);
  },
  /**
   * Send a prompt. `delivery` only matters while the session is busy: omit it
   * for the engine default (busy ⇒ steer: joins the active run at the next
   * LLM-call boundary). Resolves with the durable inbox item the engine
   * admitted (id `^msg_`, delivery, payload) — not the run itself; events
   * drive everything rendered.
   */
  prompt: (sessionID: string, text: string, delivery?: PromptDelivery) =>
    request<{ data: InboxInfo }>(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery ? { text, delivery } : { text }),
    }).then((res) => res.data),
  promptWithFiles: (
    sessionID: string,
    text: string,
    files?: PromptFile[],
    delivery?: PromptDelivery,
  ) =>
    request<{ data: InboxInfo }>(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery ? { text, files, delivery } : { text, files }),
    }).then((res) => res.data),
  /**
   * Run a slash command (the engine expands the command's template itself —
   * exactly what the TUI does). The command's argument text rides `text` (NOT
   * the old `arguments` key — sending that made every leading-slash message
   * fail validation with `Missing key at ["text"]`); `text` is required even
   * with no arguments, so it is always sent as a string.
   *
   * The command's identifier field was RENAMED upstream: the 2.0.3 engine
   * (our committed snapshot target) requires `command`, while newer engines
   * (observed 2.0.22) require `name` and reject `{command}` with
   * `Missing key at ["name"]`. The engine ignores unknown body keys, so we
   * send BOTH — `name` satisfies new engines, `command` satisfies old ones,
   * and one request works against either. (Verified live: `{name, command,
   * text}` → 204 + expanded template on 2.0.22.)
   */
  runCommand: (sessionID: string, command: string, args?: string) =>
    request<unknown>(`/api/session/${sessionID}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: command, command, text: args ?? "" }),
    }),
  /**
   * Activate a skill in the session. The route moved under
   * `/api/experimental/` and the body field was RENAMED (`skill` → `id`, a
   * skill id). Try the current route/body first; fall back to the legacy
   * route/body on 404/405 so an older engine still activates.
   */
  activateSkill: async (sessionID: string, skill: string) => {
    try {
      return await post<unknown>(`/api/experimental/session/${sessionID}/skill`, { id: skill });
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return post<unknown>(`/api/session/${sessionID}/skill`, { skill });
    }
  },

  // permissions
  pendingPermissions: () =>
    request<{ location: unknown; data: PermissionRequest[] }>("/api/permission/request"),
  /**
   * One session's pending permissions. This is the AUTHORITATIVE removal
   * evidence for a request the global listing stopped returning — see
   * `refreshQueues`. `/api/permission/request` is location-scoped and lags, so
   * "absent globally" is not on its own proof that a request was settled.
   */
  sessionPermissions: (sessionID: string) =>
    request<{ data: PermissionRequest[] }>(`/api/session/${sessionID}/permission`),
  /**
   * `POST .../permission/{id}/reply`.
   *
   * The body field was RENAMED between engine generations — `reply` in the
   * reference spec, `decision` on the current engine — and the body is
   * `additionalProperties: false`, so sending the wrong name is a hard 400 and
   * the request stays pending FOREVER. That is precisely how a "waiting in
   * another session" chip becomes impossible to clear: the answer never lands.
   * Send the current name, fall back to the legacy one on a body rejection, so
   * both generations work.
   */
  replyPermission: async (
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    message?: string,
  ) => {
    const send = (field: "decision" | "reply") =>
      request<unknown>(`/api/session/${sessionID}/permission/${requestID}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: reply, message: message ?? null }),
      });
    try {
      return await send("decision");
    } catch (err) {
      // Only a BODY rejection (unknown field) is worth retrying. Anything else
      // — network, or a 404 because it was already settled — surfaces as-is.
      const status = statusOf(err);
      if (status !== 400 && status !== 422) throw err;
      return send("reply");
    }
  },
  /**
   * The project's saved ("always allow") rules — what an `always` reply with a
   * `save` list persists. NOT location-scoped: the route takes `projectID`.
   */
  permissionSavedList: (projectID?: string) =>
    request<{ data: PermissionSavedInfo[] }>(
      `/api/permission/saved?${vcsQuery(undefined, { projectID })}`,
    ),
  /** Remove one saved permission. Returns 204. */
  permissionSavedDelete: (id: string) =>
    request<unknown>(`/api/permission/saved/${id}`, { method: "DELETE" }),

  // forms
  /**
   * The global form listing moved: `/api/form/request` is gone on the current
   * engine and the listing lives at `/api/form`. Try the current route and fall
   * back, so one stale route name cannot silently blank the question panels.
   */
  pendingForms: async () => {
    try {
      return await request<{ location: unknown; data: FormInfo[] }>("/api/form");
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return request<{ location: unknown; data: FormInfo[] }>("/api/form/request");
    }
  },
  /** Per-session form listing — fresher than the global one (which can omit
   * freshly created question-forms for minutes under load). */
  sessionForms: (sessionID: string) =>
    request<{ location: unknown; data: FormInfo[] }>(`/api/session/${sessionID}/form`),
  /**
   * One form's live state.
   *
   * Two shapes across engine generations, and the legacy one is GONE on the
   * current engine (`GET .../form/{id}/state` 404s):
   *   - current: `GET .../form/{id}` returns the form AND its `state`
   *   - legacy:  `GET .../form/{id}/state` returns the state directly
   *
   * This mattered more than it looks: a 404 from a still-PENDING form used to
   * be read by the store as "settled", so on the current engine every panel
   * aged itself out after the newborn grace. Try current, fall back to legacy,
   * and let a real 404 throw so the caller keeps its reason-based handling.
   */
  formState: async (sessionID: string, formID: string) => {
    try {
      const detail = await request<{ data: FormDetail }>(`/api/session/${sessionID}/form/${formID}`);
      return { data: detail.data?.state ?? { status: "pending" } };
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      const legacy = await request<{ data: FormState }>(`/api/session/${sessionID}/form/${formID}/state`);
      return legacy;
    }
  },
  replyForm: (sessionID: string, formID: string, answer: Record<string, string | number | boolean | string[]>) =>
    request<unknown>(`/api/session/${sessionID}/form/${formID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    }),
  /** Dismiss a form: `DELETE .../form/{id}` now, legacy `POST .../cancel`. */
  cancelForm: async (sessionID: string, formID: string) => {
    try {
      return await request<unknown>(`/api/session/${sessionID}/form/${formID}`, { method: "DELETE" });
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return request<unknown>(`/api/session/${sessionID}/form/${formID}/cancel`, { method: "POST" });
    }
  },

  // questions
  questionRequestGet: () =>
    request<{ location: unknown; data: QuestionRequest[] }>("/api/question/request"),
  sessionQuestionList: (sessionID: string) =>
    request<{ data: QuestionRequest[] }>(`/api/session/${sessionID}/question`),
  sessionQuestionReply: (sessionID: string, requestID: string, answers: QuestionAnswer[]) =>
    request<unknown>(`/api/session/${sessionID}/question/${requestID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    }),
  sessionQuestionReject: (sessionID: string, requestID: string) =>
    request<unknown>(`/api/session/${sessionID}/question/${requestID}/reject`, { method: "POST" }),

  // inbox
  inboxList: (sessionID: string) =>
    request<{ data: InboxInfo[] }>(`/api/session/${sessionID}/inbox`),
  /**
   * Flip an admitted inbox item between steer and queue.
   *
   * The engine consolidated the two action sub-routes into one update:
   * `PATCH .../inbox/{id}` with `{delivery}` (this replaced `POST .../steer`
   * and `POST .../queue`). Try the current shape first and fall back to the
   * legacy sub-route on 404/405.
   */
  inboxQueue: (sessionID: string, inboxID: string) =>
    setInboxDelivery(sessionID, inboxID, "queue"),
  inboxSteer: (sessionID: string, inboxID: string) =>
    setInboxDelivery(sessionID, inboxID, "steer"),
  inboxDelete: (sessionID: string, inboxID: string) =>
    request<unknown>(`/api/session/${sessionID}/inbox/${inboxID}`, { method: "DELETE" }),
  /** Queue-delivered prompt (durable inbox item; wakes nothing by itself). */
  inboxPrompt: (sessionID: string, text: string) => apiRaw.prompt(sessionID, text, "queue"),

  // filesystem & location
  location: () => request<LocationInfo>("/api/location"),
  locationInfo: () => request<LocationInfo>("/api/location"),
  /**
   * The project for the engine's ambient location. `GET /api/project/current`
   * was removed upstream; `/api/location` now carries the resolved `project`
   * inline. Read it from there (current first) and fall back to the legacy
   * route only when the location has no project (older engines).
   */
  projectCurrent: async (): Promise<ProjectInfo> => {
    const loc = await request<LocationInfo>("/api/location");
    if (loc.project) {
      return {
        id: loc.project.id,
        canonical: loc.project.canonical,
        directory: loc.project.directory,
      };
    }
    return request<ProjectInfo>("/api/project/current");
  },
  projectList: () => request<ProjectInfo[]>("/api/project"),
  /**
   * `PATCH /api/project/{id}` — update display metadata and workspace
   * commands. `canonical` (added upstream) moves the project's canonical
   * directory. All fields optional; only send what changes.
   */
  projectUpdate: (
    projectID: string,
    body: { canonical?: string; name?: string; icon?: { color?: string } | null; commands?: unknown[] | null },
  ) =>
    patch<unknown>(`/api/project/${projectID}`, body),

  // worktrees — location-scoped managed checkouts (the old project-scoped
  // /api/worktree/{projectID} routes were removed upstream). NOTE the response
  // shapes: `Worktree.List` is a BARE array and `Worktree.Info` a BARE object
  // (unlike most routes, these are not wrapped in `{ data }`).
  worktreeList: (location?: VcsLocation) =>
    request<WorktreeDirectory[]>(`/api/worktree?${vcsQuery(location)}`),
  worktreeCreate: (body: WorktreeCreateInput, location?: VcsLocation) =>
    request<WorktreeInfo>(`/api/worktree?${vcsQuery(location)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  worktreeRemove: (body: WorktreeRemoveInput, location?: VcsLocation) =>
    request<unknown>(`/api/worktree?${vcsQuery(location)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  /**
   * Rediscover worktrees and reconcile the shared project inventory (204).
   * The live route requires the owning project's id in the body
   * (`{ projectID }`) — resolve it from the location (the ambient project when
   * no directory is given). Older engines took no body at all, so fall back on
   * a 400/422.
   */
  worktreeRefresh: async (location?: VcsLocation) => {
    const query = vcsQuery(location);
    const loc = await request<LocationInfo>(`/api/location?${query}`);
    const projectID = loc.project?.id;
    if (!projectID) throw new Error("No project for this location — cannot refresh worktrees");
    try {
      return await request<unknown>(`/api/worktree/refresh?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectID }),
      });
    } catch (err) {
      const status = statusOf(err);
      if (status !== 400 && status !== 422) throw err;
      return request<unknown>(`/api/worktree/refresh?${query}`, { method: "POST" });
    }
  },
  fsFind: (query: string, opts?: { location?: string; type?: "file" | "directory"; limit?: number }) => {
    const params = new URLSearchParams({ query });
    if (opts?.location) params.set("location[directory]", opts.location);
    if (opts?.type) params.set("type", opts.type);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    return request<FsFindResponse>(`/api/fs/find?${params.toString()}`);
  },
  fsList: (opts?: { location?: string; path?: string }) => {
    const params = new URLSearchParams();
    if (opts?.location) params.set("location[directory]", opts.location);
    if (opts?.path) params.set("path", opts.path);
    return request<FsListResponse>(`/api/fs/list?${params.toString()}`);
  },
  fsRead: async (path: string, location?: string) => {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const params = new URLSearchParams();
    if (location) params.set("location[directory]", location);
    const qs = params.toString();
    const res = await fetch(`/api/fs/read/${encoded}${qs ? `?${qs}` : ""}`);
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(message);
    }
    return res.text();
  },
  /** Byte-exact /api/fs/read — fsRead's res.text() corrupts binary files. */
  fsReadBytes: async (path: string, location?: string): Promise<ArrayBuffer> => {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const params = new URLSearchParams();
    if (location) params.set("location[directory]", location);
    const qs = params.toString();
    const res = await fetch(`/api/fs/read/${encoded}${qs ? `?${qs}` : ""}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.arrayBuffer();
  },

  // catalog
  models: async () => {
    const res = await request<{ location: unknown; data: ModelInfo[] }>("/api/model");
    return res.data;
  },
  modelDefault: async () => {
    const res = await request<{ location: unknown; data: ModelInfo | null }>("/api/model/default");
    return res.data;
  },
  agents: async () => {
    const res = await request<{ location: unknown; data: AgentInfo[] }>("/api/agent");
    return res.data;
  },
  commands: async () => {
    const res = await request<{ location: unknown; data: CommandInfo[] }>("/api/command");
    return res.data;
  },
  skills: async () => {
    const res = await request<{ location: unknown; data: SkillInfo[] }>("/api/skill");
    return res.data;
  },

  // vcs
  vcsStatus: (location?: VcsLocation) =>
    request<{ location: unknown; data: VcsFileStatus[] }>(`/api/vcs/status?${vcsQuery(location)}`),
  vcsDiff: (
    mode: VcsMode,
    location?: VcsLocation,
    context?: number | null,
    base?: string | null,
  ) =>
    request<{ location: unknown; data: VcsDiffFile[] }>(
      `/api/vcs/diff?${vcsQuery(location, { mode, context, base })}`,
    ),
  vcsBase: (location?: VcsLocation) =>
    request<{ location: unknown; data: VcsBase | null }>(`/api/vcs/base?${vcsQuery(location)}`),
  /**
   * Branch names for the location. The route was RENAMED `vcs/branches` →
   * `vcs/branch` (and `data` is a bare `string[]`). Wrapped for the diff
   * viewer's base-branch picker (parity R7) — no UI consumes it yet.
   */
  vcsBranches: (opts: { location?: VcsLocation; search?: string; limit?: number } = {}) =>
    request<{ location: unknown; data: string[] }>(
      `/api/vcs/branch?${vcsQuery(opts.location, { search: opts.search, limit: opts.limit })}`,
    ),

  // shell
  shellList: (location?: VcsLocation) =>
    request<{ location: unknown; data: ShellInfo[] }>(`/api/shell?${vcsQuery(location)}`),
  shellCreate: (
    body: {
      command: string;
      cwd?: string;
      timeout?: number;
      metadata?: Record<string, unknown>;
    },
    location?: VcsLocation,
  ) =>
    request<{ location: unknown; data: ShellInfo }>(`/api/shell?${vcsQuery(location)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  shellGet: (id: string, location?: VcsLocation) =>
    request<{ location: unknown; data: ShellInfo }>(`/api/shell/${id}?${vcsQuery(location)}`),
  shellDelete: (id: string, location?: VcsLocation) =>
    request<unknown>(`/api/shell/${id}?${vcsQuery(location)}`, { method: "DELETE" }),
  shellOutput: (
    id: string,
    opts?: { cursor?: number; limit?: number },
    location?: VcsLocation,
  ) =>
    request<{ location: unknown; data: ShellOutputData }>(
      `/api/shell/${id}/output?${vcsQuery(location, { cursor: opts?.cursor, limit: opts?.limit })}`,
    ),

  // pty
  ptyList: (location?: VcsLocation) =>
    request<{ location: unknown; data: PtyInfo[] }>(`/api/pty?${vcsQuery(location)}`),
  ptyCreate: (
    body: {
      command: string;
      args?: string[];
      cwd?: string;
      title?: string;
      env?: Record<string, string>;
    },
    location?: VcsLocation,
  ) =>
    request<{ location: unknown; data: PtyInfo }>(`/api/pty?${vcsQuery(location)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ptyDelete: (ptyID: string, location?: VcsLocation) =>
    request<unknown>(`/api/pty/${ptyID}?${vcsQuery(location)}`, { method: "DELETE" }),
  ptyConnectToken: (ptyID: string, location?: VcsLocation) =>
    request<{ location: unknown; data: PtyConnectToken }>(
      `/api/pty/${ptyID}/connect-token?${vcsQuery(location)}`,
      { method: "POST", headers: { "x-opencode-ticket": "1" } },
    ),
  ptyUpdate: (ptyID: string, body: { title?: string; size?: { cols: number; rows: number } }, location?: VcsLocation) =>
    request<unknown>(`/api/pty/${ptyID}?${vcsQuery(location)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),

  // providers
  providerList: () =>
    request<{ location: unknown; data: ProviderInfo[] }>("/api/provider"),
  providerGet: (providerID: string) =>
    request<{ location: unknown; data: ProviderInfo }>(`/api/provider/${providerID}`),

  // integrations
  integrationList: () =>
    request<{ location: unknown; data: IntegrationInfo[] }>("/api/integration"),
  integrationConnectKey: (
    integrationID: string,
    body: { key: string; answer?: unknown; label?: string | null },
  ) =>
    post<unknown>(`/api/integration/${integrationID}/connect/key`, {
      key: body.key,
      answer: body.answer ?? null,
      label: body.label ?? null,
    }),
  integrationConnectOauth: (
    integrationID: string,
    body: { methodID: string; answer?: unknown; label?: string | null },
  ) =>
    post<{ location: unknown; data: IntegrationAttempt }>(
      `/api/integration/${integrationID}/connect/oauth`,
      { methodID: body.methodID, answer: body.answer ?? null, label: body.label ?? null },
    ),
  integrationConnectCommand: (
    integrationID: string,
    body: { methodID: string; label?: string | null },
  ) =>
    post<{
      location: unknown;
      data: { attemptID: string; time: { created: number; expires: number } };
    }>(`/api/integration/${integrationID}/connect/command`, {
      methodID: body.methodID,
      label: body.label ?? null,
    }),
  integrationOauthAttempt: (integrationID: string, attemptID: string) =>
    request<{ location: unknown; data: AttemptStatusInfo }>(
      `/api/integration/${integrationID}/connect/oauth/${attemptID}`,
    ),
  integrationCommandAttempt: (integrationID: string, attemptID: string) =>
    request<{ location: unknown; data: AttemptStatusInfo }>(
      `/api/integration/${integrationID}/connect/command/${attemptID}`,
    ),

  // mcp — the write/action routes moved under /api/experimental/mcp/* (the
  // read routes stay at /api/mcp). Every route is location-scoped; PUT (not
  // PATCH) adds a server. Current route first, legacy path on 404/405.
  mcpList: (location?: VcsLocation) =>
    request<{ location: unknown; data: McpServer[] }>(`/api/mcp?${vcsQuery(location)}`),
  mcpResource: (location?: VcsLocation) =>
    request<{ location: unknown; data: McpResourceCatalog }>(
      `/api/mcp/resource?${vcsQuery(location)}`,
    ),
  mcpPut: (server: string, config: McpServerConfig, location?: VcsLocation) =>
    mcpRequest(server, "PUT", location, { config }),
  mcpDelete: (server: string, location?: VcsLocation) =>
    mcpRequest(server, "DELETE", location),
  mcpConnect: (server: string, location?: VcsLocation) =>
    mcpRequest(server, "POST", location, null, "connect"),
  mcpDisconnect: (server: string, location?: VcsLocation) =>
    mcpRequest(server, "POST", location, null, "disconnect"),

  // plugins
  pluginList: (location?: VcsLocation) =>
    request<{ location: unknown; data: PluginInfo[] }>(`/api/plugin?${vcsQuery(location)}`),
  /** Check one (`target`) or every package plugin for available updates. */
  pluginCheck: (target?: string | null, location?: VcsLocation) =>
    post<PluginCheckResult>(`/api/plugin/check?${vcsQuery(location)}`, {
      target: target ?? null,
    }),
  /**
   * Update package plugins concurrently and tell active locations to reload
   * them. Responds once every update finished; fails if any update fails.
   * Returns 204 (no body).
   */
  pluginUpdate: (targets: string[], location?: VcsLocation) =>
    post<unknown>(`/api/plugin/update?${vcsQuery(location)}`, { targets }),
  /**
   * Wait for plugin activation at a location to settle (incl. missing-package
   * installs). Completion does NOT mean every plugin succeeded — check
   * `pluginList` state. Returns 204; cancelling the wait doesn't cancel
   * activation.
   */
  /**
   * Wait for plugin activation at a location to settle. This route was
   * REMOVED upstream (2.0.22): `POST /api/plugin/update` already responds once
   * every update (and its activation) finished. Kept as a best-effort no-op for
   * old engines — a 404/405 resolves instead of throwing, so the caller's
   * existing `.catch` is not even needed.
   */
  pluginAwaitActivation: async (location?: VcsLocation) => {
    try {
      return await post<unknown>(`/api/plugin/await-activation?${vcsQuery(location)}`, null);
    } catch (err) {
      const status = statusOf(err);
      if (status === 404 || status === 405) return undefined;
      throw err;
    }
  },

  // folder extensions (Settings › Extensions on/off switch)
  webuiExtensionState: (id: string, disabled: boolean) =>
    post<{ ok: boolean; version?: number; reload?: boolean }>(
      `/api/webui/extensions/${encodeURIComponent(id)}/state`,
      { disabled },
    ),

  // websearch
  websearchProviders: () =>
    request<{ location: unknown; data: WebSearchProvider[] }>("/api/websearch/provider"),
  websearch: (query: string, providerID: string) =>
    post<{ location: unknown; data: WebSearchResponse }>("/api/websearch", {
      query,
      providerID,
    }),

  // config & credentials
  configGet: () => request<ConfigEntry[]>("/api/config"),
  /**
   * Patch the highest-precedence GLOBAL config document (no location — this is
   * not per-project). The route moved `/api/config/preferences` →
   * `PATCH /api/experimental/config`; the live `Config.Patch` body carries only
   * `shell` (required, `null` clears), so always send it. Fall back to the
   * legacy route on 404/405. Returns 204.
   */
  configPreferencesUpdate: async (prefs: ConfigPreferencesPatch) => {
    const body = { shell: prefs.shell ?? null };
    try {
      return await patch<unknown>("/api/experimental/config", body);
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return patch<unknown>("/api/config/preferences", body);
    }
  },
  /** Shells available to terminal and agent execution. */
  configShells: () => request<ConfigShellOption[]>("/api/config/shell"),
  credentialPatch: (credentialID: string, label: string) =>
    patch<unknown>(`/api/credential/${credentialID}`, { label }),
  credentialActivate: (credentialID: string) =>
    post<unknown>(`/api/credential/${credentialID}/activate`, undefined),
  credentialDelete: (credentialID: string) =>
    request<unknown>(`/api/credential/${credentialID}`, { method: "DELETE" }),

  // server
  /**
   * `GET /api/info` (`ServerInfo`: version/pid/urls/paths). This replaced
   * `GET /api/server`, which was removed upstream. Client-only (the Settings →
   * Server tab was deliberately de-surfaced).
   */
  serverInfo: () => request<ServerInfo>("/api/info"),
  /**
   * `POST /api/pair` (`PairingCode`) — a short-lived, single-use code for a
   * `/auth/connect/:code` pairing link. No request body.
   */
  pairCode: () => request<{ code: string; expires_in: number }>("/api/pair", { method: "POST" }),

  // misc
  /**
   * Stateless one-shot generation. The route moved `/api/generate` →
   * `POST /api/experimental/generate`; fall back to the legacy path on
   * 404/405. Client-only (plugins/tools call it via `ctx.generate.text`).
   */
  generate: async (prompt: string, model?: ModelRef | null) => {
    const body = { prompt, model: model ?? null };
    try {
      return await post<GenerateResponse>("/api/experimental/generate", body);
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 405) throw err;
      return post<GenerateResponse>("/api/generate", body);
    }
  },
  referenceList: () =>
    request<{ location: unknown; data: ReferenceInfo[] }>("/api/reference"),
};

// ---- hook instrumentation (spec §5.1 + §11 step 2) --------------------------
//
// Every endpoint fires open-string hook events — no registry change is needed
// for new seams. `api.pre` may MUTATE `ctx.args` (an unknown[] spread into the
// endpoint); `api.post` observes `{ name, args, result }`; `api.error`
// observes `{ name, args, error }` and the original error is rethrown.
// Hook failures never break the call — fireHooks isolates per handler.

type ApiRaw = typeof apiRaw;

function wrapApi<T extends Record<string, unknown>>(raw: T): T {
  const wrapped = {} as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    const fn = (raw as Record<string, unknown>)[key];
    if (typeof fn !== "function") {
      wrapped[key] = fn;
      continue;
    }
    wrapped[key] = async (...args: unknown[]) => {
      const preCtx: Record<string, unknown> = { name: key, args };
      await fireHooks("api.pre", preCtx);
      const finalArgs = Array.isArray(preCtx.args) ? (preCtx.args as unknown[]) : args;
      try {
        const result = await (fn as (...a: unknown[]) => unknown)(...finalArgs);
        await fireHooks("api.post", { name: key, args: finalArgs, result });
        return result;
      } catch (error) {
        await fireHooks("api.error", { name: key, args: finalArgs, error });
        throw error;
      }
    };
  }
  return wrapped as T;
}

export const api: ApiRaw = wrapApi(apiRaw);
