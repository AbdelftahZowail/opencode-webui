/**
 * Schema types derived from the opencode v2 OpenAPI document
 * (GET /openapi.json on the running service). Keep this file in sync
 * when the API changes; the openapi.json diff is the source of truth.
 */

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface LocationRef {
  directory: string;
  workspaceID?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface StructuredError {
  type: string;
  message: string;
  status?: number;
}

export interface SessionInfo {
  id: string;
  parentID?: string;
  projectID: string;
  agent?: string;
  model?: ModelRef;
  cost: number;
  tokens: TokenUsage;
  time: { created: number; updated: number; archived?: number };
  title?: string;
  location: LocationRef;
  subpath?: string;
  /** Free-form origin tagging, e.g. `{ origin: "brother-agent" }`. Mirrors
   * openapi `Session.Info.metadata` (our hand-copied type lagged behind). */
  metadata?: Record<string, unknown>;
}

export interface SessionsResponse {
  data: SessionInfo[];
  cursor: { previous: string | null; next: string | null };
}

export interface MessagesResponse {
  data: MessageInfo[];
  cursor: { previous: string | null; next: string | null };
}

// ---- messages -----------------------------------------------------------

export type MessageInfo =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | SyntheticMessage
  | SkillMessage
  | ShellMessage
  | AgentSelectedMessage
  | ModelSelectedMessage
  | LocationSwitchedMessage
  | CompactionMessage;

interface MessageBase {
  id: string;
  metadata?: Record<string, unknown>;
  time: { created: number; completed?: number };
}

export interface UserMessage extends MessageBase {
  type: "user";
  text: string;
  files?: FileAttachment[];
  agents?: unknown[];
  skills?: unknown[];
}

export interface AssistantMessage extends MessageBase {
  type: "assistant";
  agent?: string;
  model?: ModelRef;
  content: AssistantPart[];
  finish?: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown";
  cost?: number;
  tokens?: TokenUsage;
  error?: StructuredError;
}

export interface SystemMessage extends MessageBase {
  type: "system";
  text: string;
  description?: string;
}

export interface SyntheticMessage extends MessageBase {
  type: "synthetic";
  text: string;
  description?: string;
}

export interface SkillMessage extends MessageBase {
  type: "skill";
  skill: string;
  name: string;
  text: string;
}

export interface ShellMessage extends MessageBase {
  type: "shell";
  shellID: string;
  command: string;
  status: "running" | "exited" | "timeout" | "killed";
  exit?: number;
  output?: { output: string; cursor: number; size: number; truncated: boolean };
}

export interface AgentSelectedMessage extends MessageBase {
  type: "agent-switched";
  agent: string;
  previous?: string;
}

export interface ModelSelectedMessage extends MessageBase {
  type: "model-switched";
  model: ModelRef;
  previous?: ModelRef;
}

export interface LocationSwitchedMessage extends MessageBase {
  type: "location-switched";
  location: LocationRef;
  projectID?: string;
  subpath?: string;
}

export interface CompactionMessage extends MessageBase {
  type: "compaction";
  status: "running" | "completed" | "failed";
  reason?: "auto" | "manual";
  summary?: string;
  recent?: string;
  error?: StructuredError;
}

export type AssistantPart = TextPart | ReasoningPart | ToolPart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  executed?: boolean;
  state: ToolState;
  time: { created: number; ran?: number; completed?: number };
}

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: ToolContent[]; metadata?: Record<string, unknown> }
  | { status: "error"; input: Record<string, unknown>; error: StructuredError; content?: ToolContent[] };

export type ToolContent = { type: "text"; text: string } | { type: "file"; uri?: string; data?: string; mime: string; name?: string };

// ---- permissions --------------------------------------------------------

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
}

// ---- forms --------------------------------------------------------------

export type FormField =
  | { key: string; type: "string"; title?: string; description?: string; required?: boolean; placeholder?: string; default?: string; options?: FormOption[]; format?: string }
  | { key: string; type: "number" | "integer"; title?: string; description?: string; required?: boolean; default?: number }
  | { key: string; type: "boolean"; title?: string; description?: string; required?: boolean; default?: boolean }
  | { key: string; type: "multiselect"; title?: string; description?: string; required?: boolean; options: FormOption[]; default?: string[] }
  | { key: string; type: "external"; url: string; title?: string; description?: string };

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: FormField[];
}

export interface FormState {
  status: "pending" | "answered" | "cancelled";
  answer?: Record<string, string | number | boolean | string[]>;
}

// ---- catalog ------------------------------------------------------------

export interface ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  family?: string;
  name: string;
  status: "alpha" | "beta" | "deprecated" | "active";
  enabled: boolean;
  limit: { context: number; input?: number; output: number };
  /** Server-side reasoning-effort variants (Model.Variant[].id). */
  variants?: { id: string }[];
}

export interface AgentInfo {
  id: string;
  name: string;
  model?: ModelRef;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
}

export interface CommandInfo {
  name: string;
  template: string;
  description?: string;
  agent?: string;
  model?: ModelRef;
}

export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  slash?: boolean;
  autoinvoke?: boolean;
  location: string;
  content: string;
}

/** Prompt.FileAttachment — the shape history returns for user message files. */
export interface FileAttachment {
  data: string;
  mime: string;
  source: { type: "inline" } | { type: "uri"; uri: string };
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
}

// ---- questions ----------------------------------------------------------

export interface QuestionOption {
  label: string;
  /** Wire value sent back in answers (form-channel questions; defaults to label). */
  value?: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionTool {
  messageID: string;
  id: string;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: QuestionTool;
}

export type QuestionAnswer = string[];

// ---- inbox --------------------------------------------------------------

export type InboxDelivery = "steer" | "queue";

export interface InboxUserPayload {
  text: string;
  files?: unknown[];
  agents?: unknown[];
  skills?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface InboxSyntheticPayload {
  text: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export type InboxPayload = InboxUserPayload | InboxSyntheticPayload | Record<string, unknown>;

export interface InboxInfo {
  id: string;
  sessionID: string;
  timeCreated: number;
  type: "user" | "synthetic" | "compaction" | "move";
  payload: InboxPayload;
  delivery: InboxDelivery;
}
