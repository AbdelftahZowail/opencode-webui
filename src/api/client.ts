/**
 * Minimal typed client for the opencode v2 HTTP API.
 * All requests go through the same-origin /api path (proxied by the Bun
 * server, which attaches service auth). Streaming endpoints are in
 * events.ts.
 */

import type {
  AgentInfo,
  CommandInfo,
  FormInfo,
  FormState,
  InboxInfo,
  MessageInfo,
  MessagesResponse,
  ModelInfo,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  SessionInfo,
  SessionsResponse,
  SkillInfo,
} from "./types";

export type ForkBoundary =
  | { type: "before"; messageID: string }
  | { type: "through" };

export type CompactDelivery = "steer" | "queue";

export interface SessionExportData {
  info: SessionInfo;
  messages: MessageInfo[];
}

export type VcsMode = "working" | "branch";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
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
  integrationID?: string;
  name: string;
  disabled?: boolean;
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

export interface PluginInfo {
  id: string;
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

export interface ServerInfo {
  urls: string[];
}

export interface ServiceStopResponse {
  accepted: boolean;
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

export const api = {
  health: () => request<{ ok: boolean; service?: string; error?: string }>("/api/webui/status"),

  // sessions
  listSessions: (opts: { limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50), order: "desc" });
    if (opts.cursor) params.set("cursor", opts.cursor);
    return request<SessionsResponse>(`/api/session?${params.toString()}`);
  },
  activeSessions: () =>
    request<{ data: Record<string, { type: "running" }> }>("/api/session/active"),
  createSession: (body: { title?: string | null; agent?: string | null; model?: ModelRef | null; location?: { directory: string } | null }) =>
    request<{ data: SessionInfo }>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  getSession: (sessionID: string) =>
    request<{ data: SessionInfo }>(`/api/session/${sessionID}`),
  renameSession: (sessionID: string, title: string) =>
    request<unknown>(`/api/session/${sessionID}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  forkSession: (sessionID: string, boundary: ForkBoundary) =>
    request<{ data: SessionInfo }>(`/api/session/${sessionID}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boundary }),
    }),
  exportSession: (sessionID: string, sanitize = false) =>
    request<{ data: SessionExportData }>(
      `/api/session/${sessionID}/export?sanitize=${sanitize}`,
    ),
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
  interrupt: (sessionID: string) =>
    request<unknown>(`/api/session/${sessionID}/interrupt`, { method: "POST" }),
  /** Background the session's synchronous (task-tool) subagents. */
  sessionBackground: (sessionID: string) =>
    request<unknown>(`/api/session/${sessionID}/background`, { method: "POST" }),
  sessionShell: (sessionID: string, command: string) =>
    request<unknown>(`/api/session/${sessionID}/shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), command }),
    }),

  // messaging
  messages: (sessionID: string, limit = 100) =>
    request<MessagesResponse>(`/api/session/${sessionID}/message?limit=${limit}&order=desc`),
  prompt: (sessionID: string, text: string) =>
    request<unknown>(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  promptWithFiles: (sessionID: string, text: string, files?: PromptFile[]) =>
    request<unknown>(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, files }),
    }),
  runCommand: (sessionID: string, command: string, args?: string) =>
    request<unknown>(`/api/session/${sessionID}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, arguments: args ?? null }),
    }),
  activateSkill: (sessionID: string, skill: string) =>
    request<unknown>(`/api/session/${sessionID}/skill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill }),
    }),

  // permissions
  pendingPermissions: () =>
    request<{ location: unknown; data: PermissionRequest[] }>("/api/permission/request"),  replyPermission: (sessionID: string, requestID: string, reply: PermissionReply) =>
    request<unknown>(`/api/session/${sessionID}/permission/${requestID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply, message: null }),
    }),

  // forms
  pendingForms: () => request<{ location: unknown; data: FormInfo[] }>("/api/form/request"),
  formState: (sessionID: string, formID: string) =>
    request<FormState>(`/api/session/${sessionID}/form/${formID}/state`),
  replyForm: (sessionID: string, formID: string, answer: Record<string, string | number | boolean | string[]>) =>
    request<unknown>(`/api/session/${sessionID}/form/${formID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    }),
  cancelForm: (sessionID: string, formID: string) =>
    request<unknown>(`/api/session/${sessionID}/form/${formID}/cancel`, { method: "POST" }),

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
  inboxQueue: (sessionID: string, inboxID: string) =>
    request<unknown>(`/api/session/${sessionID}/inbox/${inboxID}/queue`, { method: "POST" }),
  inboxSteer: (sessionID: string, inboxID: string) =>
    request<unknown>(`/api/session/${sessionID}/inbox/${inboxID}/steer`, { method: "POST" }),
  inboxDelete: (sessionID: string, inboxID: string) =>
    request<unknown>(`/api/session/${sessionID}/inbox/${inboxID}`, { method: "DELETE" }),
  inboxPrompt: (sessionID: string, text: string) =>
    request<unknown>(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, delivery: "queue" }),
    }),

  // filesystem & location
  location: () => request<LocationInfo>("/api/location"),
  locationInfo: () => request<LocationInfo>("/api/location"),
  projectCurrent: () => request<ProjectInfo>("/api/project/current"),
  projectList: () => request<ProjectInfo[]>("/api/project"),
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

  // catalog
  models: async () => {
    const res = await request<{ location: unknown; data: ModelInfo[] }>("/api/model");
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
  vcsDiff: (mode: VcsMode, location?: VcsLocation, context?: number | null) =>
    request<{ location: unknown; data: VcsDiffFile[] }>(
      `/api/vcs/diff?${vcsQuery(location, { mode, context })}`,
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
  shellTimeout: (id: string, timeout: number, location?: VcsLocation) =>
    request<{ location: unknown; data: ShellInfo }>(
      `/api/shell/${id}/timeout?${vcsQuery(location)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeout }),
      },
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

  // mcp
  mcpList: () =>
    request<{ location: unknown; data: McpServer[] }>("/api/mcp"),
  mcpResource: () =>
    request<{ location: unknown; data: McpResourceCatalog }>("/api/mcp/resource"),
  mcpPut: (server: string, config: McpServerConfig) =>
    patch<unknown>(`/api/mcp/${server}`, { config }),
  mcpDelete: (server: string) =>
    request<unknown>(`/api/mcp/${server}`, { method: "DELETE" }),
  mcpConnect: (server: string) =>
    post<unknown>(`/api/mcp/${server}/connect`, null),
  mcpDisconnect: (server: string) =>
    post<unknown>(`/api/mcp/${server}/disconnect`, null),

  // plugins
  pluginList: () =>
    request<{ location: unknown; data: PluginInfo[] }>("/api/plugin"),

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
  credentialPatch: (credentialID: string, label: string) =>
    patch<unknown>(`/api/credential/${credentialID}`, { label }),
  credentialDelete: (credentialID: string) =>
    request<unknown>(`/api/credential/${credentialID}`, { method: "DELETE" }),

  // server
  serverInfo: () => request<ServerInfo>("/api/server"),
  serviceStop: (instanceID?: string) =>
    post<ServiceStopResponse>("/api/service/stop", { instanceID: instanceID ?? "" }),

  // misc
  generate: (prompt: string, model?: ModelRef | null) =>
    post<GenerateResponse>("/api/generate", { prompt, model: model ?? null }),
  referenceList: () =>
    request<{ location: unknown; data: ReferenceInfo[] }>("/api/reference"),
};
