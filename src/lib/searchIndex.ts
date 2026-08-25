import { api } from "../api/client";
import type { MessageInfo, SessionInfo } from "../api/types";

/**
 * Sidebar content-search index (layer C of session search).
 *
 * Lazily builds a per-app-session cache of sessionID -> lowercased
 * concatenated message text (user + assistant prose, plus shell commands /
 * skill notes / compaction summaries). Cached forever for the page lifetime;
 * queries scan only the cache, fetching uncached sessions in small parallel
 * batches and reporting partial matches as they land.
 */

const index = new Map<string, string>();

/** Never index more than the N most recently updated sessions per query. */
const MAX_INDEXED_SESSIONS = 300;

/** Parallel message fetches while building the cache. */
const FETCH_CONCURRENCY = 4;

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

async function indexSession(id: string): Promise<void> {
  try {
    const res = await api.messages(id, 100);
    index.set(id, res.data.map(messageText).join("\n").toLowerCase());
  } catch {
    // Unreachable/deleted session: cache an empty doc so it is never retried.
    index.set(id, "");
  }
}

/**
 * Return ids of sessions whose MESSAGES contain `query` (lowercased
 * substring). `sessions` is the caller's known session list (already sorted
 * newest-first is fine — re-sorted defensively); only the most recent
 * MAX_INDEXED_SESSIONS are eligible for indexing. `onProgress` fires after
 * each fetch batch with the match set so far, enabling progressive UI.
 */
export function searchContent(
  query: string,
  sessions: SessionInfo[],
  onProgress?: (matches: Set<string>) => void,
): Promise<Set<string>> {
  const q = query.trim().toLowerCase();
  if (!q) return Promise.resolve(new Set());

  const targets = [...sessions]
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, MAX_INDEXED_SESSIONS)
    .map((s) => s.id)
    .filter((id) => !index.has(id));

  const scan = (): Set<string> => {
    const hits = new Set<string>();
    for (const [id, text] of index) {
      if (text.includes(q)) hits.add(id);
    }
    return hits;
  };

  const run = async (): Promise<Set<string>> => {
    for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
      const batch = targets.slice(i, i + FETCH_CONCURRENCY);
      await Promise.all(batch.map(indexSession));
      onProgress?.(scan());
    }
    return scan();
  };
  return run();
}
