/**
 * R9 transcript derivations — pure, React-free helpers behind the grouped
 * transcript (`MessageItem.tsx`), the per-turn token line (`TurnTokens.tsx`)
 * and the revert view detail (`Conversation.tsx`).
 *
 * Everything here is a pure function of the message model so it can be unit-
 * tested without a DOM, and so the components stay about chrome. Grouping is
 * performed WITHIN one assistant message's `content` (the TUI groups
 * consecutive parts of a turn; our model stores a turn's parts as consecutive
 * assistant messages, and this pass keeps each message row intact — see the
 * R9 report for the cross-message limitation).
 */

import type {
  AssistantMessage,
  AssistantPart,
  CompactionMessage,
  MessageInfo,
  ModelRef,
  ReasoningPart,
  TextPart,
  TokenUsage,
  ToolPart,
} from "../api/types";

// ---------------------------------------------------------------------------
// Reasoning + exploration grouping
// ---------------------------------------------------------------------------

/** The exploration tools v2 collapses into one row (R9). */
const EXPLORATION_TOOLS = new Set(["read", "glob", "grep"]);

export function isExplorationTool(name: string): boolean {
  return EXPLORATION_TOOLS.has(name.toLowerCase());
}

/** One part inside a group, with its original content index + stable key. */
export interface PartEntry<T> {
  part: T;
  index: number;
  key: string;
}

/**
 * A run of consecutive assistant parts. `reasoning` collapses every
 * consecutive reasoning part; `explore` collapses 2+ consecutive
 * read/glob/grep tool parts; `single` is everything else (rendered exactly as
 * before).
 */
export type PartGroup =
  | { kind: "reasoning"; key: string; entries: PartEntry<ReasoningPart>[] }
  | { kind: "explore"; key: string; entries: PartEntry<ToolPart>[] }
  | { kind: "single"; key: string; part: AssistantPart; index: number };

/**
 * Stable per-part key — byte-identical to the scheme MessageItem used before
 * grouping (`${messageID}:tool:${id}` and `${messageID}:${type}:${ordinal}`),
 * so the module-level disclosure maps keep matching across the change.
 */
function partKey(
  messageID: string,
  part: AssistantPart,
  ordinal: Record<string, number>,
): string {
  if (part.type === "tool") return `${messageID}:tool:${part.id}`;
  const n = ordinal[part.type] ?? 0;
  ordinal[part.type] = n + 1;
  return `${messageID}:${part.type}:${n}`;
}

/**
 * Group an assistant message's `content` into renderable runs. Order is
 * preserved; keys are stable across polls (so React reconciles in place and
 * disclosure state survives a streaming commit).
 */
export function groupParts(content: AssistantPart[], messageID: string): PartGroup[] {
  const groups: PartGroup[] = [];
  const ordinal: Record<string, number> = {};
  let i = 0;
  while (i < content.length) {
    const part = content[i]!;

    if (part.type === "reasoning") {
      const first = i;
      const entries: PartEntry<ReasoningPart>[] = [];
      while (i < content.length && content[i]!.type === "reasoning") {
        const p = content[i] as ReasoningPart;
        entries.push({ part: p, index: i, key: partKey(messageID, p, ordinal) });
        i++;
      }
      groups.push({ kind: "reasoning", key: `${messageID}:reasoning-group:${first}`, entries });
      continue;
    }

    if (part.type === "tool" && isExplorationTool(part.name)) {
      const first = i;
      const entries: PartEntry<ToolPart>[] = [];
      while (
        i < content.length &&
        content[i]!.type === "tool" &&
        isExplorationTool((content[i] as ToolPart).name)
      ) {
        const p = content[i] as ToolPart;
        entries.push({ part: p, index: i, key: partKey(messageID, p, ordinal) });
        i++;
      }
      // A lone read/glob/grep is already a one-line row — only 2+ collapse.
      if (entries.length === 1) {
        const only = entries[0]!;
        groups.push({ kind: "single", key: only.key, part: only.part, index: only.index });
      } else {
        groups.push({ kind: "explore", key: `${messageID}:explore-group:${first}`, entries });
      }
      continue;
    }

    groups.push({ kind: "single", key: partKey(messageID, part, ordinal), part, index: i });
    i++;
  }
  return groups;
}

/** "2 files read · 1 search" — the collapsed exploration row's detail. */
export function exploreSummary(entries: { part: ToolPart }[]): string {
  const counts = new Map<string, number>();
  for (const { part } of entries) counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
  const label = (name: string, n: number): string => {
    if (name === "read") return `${n} file${n === 1 ? "" : "s"} read`;
    if (name === "grep") return `${n} search${n === 1 ? "" : "es"}`;
    if (name === "glob") return `${n} file scan${n === 1 ? "" : "s"}`;
    return `${n} ${name}`;
  };
  return [...counts.entries()].map(([name, n]) => label(name, n)).join(" · ");
}

// ---------------------------------------------------------------------------
// Per-turn token usage (R9)
// ---------------------------------------------------------------------------

/** One assistant API step's usage — a row of the per-turn token table. */
export interface TurnTokenStep {
  id: string;
  model?: ModelRef;
  tokens: TokenUsage;
}

export interface TurnTokenUsage {
  steps: number;
  /** Fresh prompt tokens (`tokens.input`). */
  newTokens: number;
  /** Cache reads + writes. */
  cachedTokens: number;
  /** Visible output + reasoning tokens. */
  outputTokens: number;
  totalTokens: number;
}

/** The steps (assistant messages that report usage) of one turn/response. */
export function turnSteps(messages: AssistantMessage[]): TurnTokenStep[] {
  const steps: TurnTokenStep[] = [];
  for (const m of messages) {
    if (m.tokens) steps.push({ id: m.id, model: m.model, tokens: m.tokens });
  }
  return steps;
}

/** Aggregate one turn's per-step usage into the header line's numbers. */
export function aggregateTokens(steps: TurnTokenStep[]): TurnTokenUsage {
  let input = 0;
  let cached = 0;
  let output = 0;
  for (const s of steps) {
    input += s.tokens.input;
    cached += s.tokens.cache.read + s.tokens.cache.write;
    output += s.tokens.output + s.tokens.reasoning;
  }
  return {
    steps: steps.length,
    newTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    totalTokens: input + cached + output,
  };
}

/** "1.2k" / "3.4M" / "512" — compact token counts. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Copy variants (R9)
// ---------------------------------------------------------------------------

/** The prose of one assistant message (text parts only), joined. */
export function assistantTextParts(message: AssistantMessage): string {
  return message.content
    .filter((p): p is TextPart => p.type === "text" && p.text.trim() !== "")
    .map((p) => p.text)
    .join("\n\n");
}

/**
 * The whole text of the LAST consecutive assistant block (the "copy last
 * response" variant). Returns "" when the transcript has no assistant prose.
 */
export function lastAssistantResponseText(messages: MessageInfo[]): string {
  let end = messages.length - 1;
  while (end >= 0 && messages[end]!.type !== "assistant") end--;
  if (end < 0) return "";
  const parts: string[] = [];
  for (let i = end; i >= 0 && messages[i]!.type === "assistant"; i--) {
    const text = assistantTextParts(messages[i] as AssistantMessage);
    if (text) parts.unshift(text);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Revert view detail (R9)
// ---------------------------------------------------------------------------

export interface RevertDetail {
  /** Messages the staged revert would drop (the removed range). */
  count: number;
  /** Workspace files the removed turn(s) touched, sorted + de-duplicated. */
  files: string[];
}

/** Files touched by edit/write/patch tool parts across `messages`. */
export function filesTouched(messages: MessageInfo[]): string[] {
  const set = new Set<string>();
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const part of m.content) {
      if (part.type !== "tool") continue;
      if (!["edit", "write", "apply_patch", "patch"].includes(part.name)) continue;
      const state = part.state;
      if (state.status === "streaming") continue;
      const input = state.input ?? {};
      const meta = "metadata" in state ? state.metadata : undefined;
      const metaFiles = meta && Array.isArray((meta as { files?: unknown }).files)
        ? (meta as { files?: { file?: unknown }[] }).files
        : undefined;
      if (metaFiles) {
        for (const f of metaFiles) {
          if (f && typeof f.file === "string" && f.file) set.add(f.file);
        }
      }
      if (typeof input.path === "string" && input.path) set.add(input.path);
    }
  }
  return [...set].sort();
}

/**
 * The staged-revert detail for the banner: how many messages sit after the
 * revert marker and which files they touched. `null` when there is no marker
 * or the marker is not in the transcript.
 */
export function collectRevertDetail(
  messages: MessageInfo[],
  markerID: string | null | undefined,
): RevertDetail | null {
  if (!markerID) return null;
  const idx = messages.findIndex((m) => m.id === markerID);
  if (idx < 0) return null;
  const removed = messages.slice(idx + 1);
  if (removed.length === 0) return null;
  return { count: removed.length, files: filesTouched(removed) };
}

// ---------------------------------------------------------------------------
// Compaction detail (R9)
// ---------------------------------------------------------------------------

export interface CompactionDetail {
  /** Compaction input/output tokens when the engine reported them. */
  tokens?: { input: number; output: number };
  /** A failed compaction whose error reads as a cancellation. */
  cancelled: boolean;
}

/**
 * `Session.Message.Compaction.Completed`/`.Failed` carry `tokens` on the
 * engine, but our hand-copied `CompactionMessage` type omits it — read it
 * structurally so the line appears the moment the type catches up (see R9
 * report: add `tokens?`/`cost?`/`model?` to `CompactionMessage`).
 */
export function compactionDetail(message: CompactionMessage): CompactionDetail {
  const tokens = (message as { tokens?: TokenUsage }).tokens;
  const errType = (message.error?.type ?? "").toLowerCase();
  const errMsg = (message.error?.message ?? "").toLowerCase();
  // The engine surfaces a user cancellation as an aborted run; accept either
  // the type or the message naming it.
  const cancelled =
    message.status === "failed" && /cancel|abort/.test(`${errType} ${errMsg}`);
  return {
    tokens: tokens
      ? {
          input: tokens.input + tokens.cache.read + tokens.cache.write,
          output: tokens.output + tokens.reasoning,
        }
      : undefined,
    cancelled,
  };
}
