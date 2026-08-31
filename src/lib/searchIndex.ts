import { api } from "../api/client";
import type { MessageInfo, SessionInfo } from "../api/types";

/**
 * Sidebar content-search index (layer C of session search).
 *
 * Lazily builds a per-app-session cache of sessionID -> per-message
 * searchable text (user + assistant prose, plus shell commands / skill
 * notes / compaction summaries). Cached forever for the page lifetime;
 * queries scan only the cache, fetching uncached sessions in small parallel
 * batches and reporting partial matches as they land.
 */

export interface MessageHit {
  messageID: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export type ContentHits = Map<string, MessageHit[]>;

/** Never index more than the N most recently updated sessions per query. */
const MAX_INDEXED_SESSIONS = 300;

/** Parallel message fetches while building the cache. */
const FETCH_CONCURRENCY = 4;

/** Chars of context on each side of the match (~80 total). */
const SNIPPET_CONTEXT = 40;

type IndexedEntry = {
  messages: { id: string; text: string; lower: string }[];
  combinedLower: string;
};

const index = new Map<string, IndexedEntry>();

/** Drop every cached transcript (e.g. after bulk session deletion). */
export function clearSearchIndex(): void {
  index.clear();
}

/** Extract the searchable prose of one message; unions guard optional fields. */
function messageText(m: MessageInfo): string {
  switch (m.type) {
    case "user":
    case "system":
    case "synthetic":
    case "skill":
      return m.text ?? "";
    case "shell":
      return m.command ?? "";
    case "compaction":
      return m.summary ?? "";
    case "assistant": {
      let out = "";
      for (const part of m.content ?? []) {
        if (part?.type === "text") out += part.text + "\n";
      }
      return out;
    }
    default:
      // agent-switched / model-switched / location-switched carry no prose.
      return "";
  }
}

function buildSnippet(text: string, qLower: string, qLen: number): { snippet: string; matchStart: number; matchEnd: number } | null {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(text.length, idx + qLen + SNIPPET_CONTEXT);
  let snippet = text.slice(start, end).replace(/\s+/g, " ");
  const snippetLower = snippet.toLowerCase();
  const sIdx = snippetLower.indexOf(qLower);
  let matchStart = sIdx !== -1 ? sIdx : idx - start;
  let matchEnd = matchStart + qLen;
  if (matchStart < 0) matchStart = 0;
  if (matchEnd > snippet.length) matchEnd = snippet.length;
  const prefix = start > 0 ? "… " : "";
  const suffix = end < text.length ? " …" : "";
  if (prefix) {
    snippet = prefix + snippet;
    matchStart += prefix.length;
    matchEnd += prefix.length;
  }
  if (suffix) snippet = snippet + suffix;
  return { snippet, matchStart, matchEnd };
}

async function indexSession(id: string): Promise<void> {
  try {
    const res = await api.messages(id, 100);
    const msgs = res.data
      .map((m) => {
        const t = messageText(m);
        return t ? { id: m.id, text: t, lower: t.toLowerCase() } : null;
      })
      .filter((x): x is { id: string; text: string; lower: string } => !!x);
    const combinedLower = msgs.map((m) => m.lower).join("\n");
    index.set(id, { messages: msgs, combinedLower });
  } catch {
    // Unreachable/deleted session: cache an empty doc so it is never retried.
    index.set(id, { messages: [], combinedLower: "" });
  }
}

function scan(qLower: string): ContentHits {
  const hits: ContentHits = new Map();
  const qLen = qLower.length;
  for (const [id, entry] of index) {
    if (!entry.combinedLower.includes(qLower)) continue;
    const perMsg: MessageHit[] = [];
    for (const m of entry.messages) {
      if (!m.lower.includes(qLower)) continue;
      const sn = buildSnippet(m.text, qLower, qLen);
      if (!sn) continue;
      perMsg.push({ messageID: m.id, snippet: sn.snippet, matchStart: sn.matchStart, matchEnd: sn.matchEnd });
    }
    if (perMsg.length > 0) hits.set(id, perMsg);
  }
  return hits;
}

/**
 * Return per-session per-message hits whose MESSAGES contain `query` (lowercased
 * substring). `sessions` is the caller's known session list (already sorted
 * newest-first is fine — re-sorted defensively); only the most recent
 * MAX_INDEXED_SESSIONS are eligible for indexing. `onProgress` fires after
 * each fetch batch with the match set so far, enabling progressive UI.
 */
export function searchContent(
  query: string,
  sessions: SessionInfo[],
  onProgress?: (matches: ContentHits) => void,
): Promise<ContentHits> {
  const q = query.trim().toLowerCase();
  if (!q) return Promise.resolve(new Map());

  const targets = [...sessions]
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, MAX_INDEXED_SESSIONS)
    .map((s) => s.id)
    .filter((id) => !index.has(id));

  const run = async (): Promise<ContentHits> => {
    for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
      const batch = targets.slice(i, i + FETCH_CONCURRENCY);
      await Promise.all(batch.map(indexSession));
      onProgress?.(scan(q));
    }
    return scan(q);
  };
  return run();
}

/** Legacy helper: session IDs only (derived from ContentHits). */
export function contentHitIDs(hits: ContentHits): Set<string> {
  return new Set(hits.keys());
}
