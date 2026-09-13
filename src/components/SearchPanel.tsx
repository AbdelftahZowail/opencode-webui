import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { api } from "../api/client";
import type { SessionInfo } from "../api/types";
import { searchContent, type ContentHits, type MessageHit } from "../lib/searchIndex";
import { findHome, workspaceName } from "../lib/workspaces";
import { setHighlightMessage, selectSession, useStore } from "../store";
import { Target } from "../extensions/registry";

/** Content/server search kicks in from this query length. */
const SEARCH_DEBOUNCE_MIN_LENGTH = 2;
/** Cap on sessions listed purely because a message matched. */
const CONTENT_GROUP_LIMIT = 20;
const HITS_PER_SESSION = 5;

export interface SearchPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Global session search as a slide-out overlay panel (replaces the old
 * always-visible sidebar field). Opens from ⌘F / Ctrl+F or the sidebar
 * search button; closes on Esc, a press outside the panel, focus leaving
 * the panel, or the field's X. Three match layers: title/workspace (local),
 * server-side title search, and message-content search.
 */
export function SearchPanel({ open, onClose }: SearchPanelProps) {
  const sessions = useStore((s) => s.sessions);
  const activeIDs = useStore((s) => s.activeIDs);
  const running = useStore((s) => s.running);
  const current = useStore((s) => s.currentSessionID);

  const [query, setQuery] = useState("");
  const [serverHits, setServerHits] = useState<SessionInfo[]>([]);
  const [contentHits, setContentHits] = useState<ContentHits>(new Map());
  const [contentSearching, setContentSearching] = useState(false);
  const [collapsedHits, setCollapsedHits] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();

  // Fresh session on every open: drop stale results and focus the field.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setServerHits([]);
    setContentHits(new Map());
    setContentSearching(false);
    setCollapsedHits(new Set());
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [open]);

  // Dismiss on Esc, a press outside the panel, or focus moving out of it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase so the site-wide Esc (interrupt) never sees it.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current && target && !panelRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open, onClose]);

  const home = useMemo(() => findHome(sessions.map((s) => s.location?.directory)), [sessions]);

  // Parents with a currently running/queued subagent child, for the row marker.
  const subagentActiveParents = useMemo(() => {
    const parents = new Set<string>();
    for (const s of sessions) {
      if (s.parentID && (running[s.id] || activeIDs.includes(s.id))) parents.add(s.parentID);
    }
    return parents;
  }, [sessions, running, activeIDs]);

  // Layer B: server-side title search, debounced 250ms once the query is
  // >= 2 chars — catches sessions beyond the currently loaded pages.
  useEffect(() => {
    if (!open) return;
    if (trimmedQuery.length < SEARCH_DEBOUNCE_MIN_LENGTH) {
      setServerHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .listSessions({ search: trimmedQuery, limit: 100 })
        .then((res) => {
          if (!cancelled) setServerHits(res.data.filter((s) => !s.parentID));
        })
        .catch(() => {
          if (!cancelled) setServerHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, trimmedQuery]);

  // Layer C: message content search over the known sessions, debounced 250ms.
  useEffect(() => {
    if (!open) return;
    if (trimmedQuery.length < SEARCH_DEBOUNCE_MIN_LENGTH) {
      setContentHits(new Map());
      setContentSearching(false);
      return;
    }
    let cancelled = false;
    setContentSearching(true);
    const timer = setTimeout(() => {
      searchContent(trimmedQuery, sessions, (partial) => {
        if (!cancelled) setContentHits(new Map(partial));
      })
        .catch(() => new Map<string, MessageHit[]>())
        .then((matches) => {
          if (!cancelled) {
            setContentHits(new Map(matches));
            setContentSearching(false);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, trimmedQuery, sessions]);

  const groups = useMemo(() => {
    const buckets = new Map<string, SessionInfo[]>();
    const seen = new Set<string>();
    for (const s of sessions) {
      // Subagent (child) sessions are managed inside their parent session.
      if (s.parentID) continue;
      if (
        normalizedQuery &&
        !(s.title ?? "Untitled session").toLowerCase().includes(normalizedQuery) &&
        !workspaceName(s.location?.directory, home).toLowerCase().includes(normalizedQuery) &&
        !(s.location?.directory ?? "").toLowerCase().includes(normalizedQuery)
      ) {
        continue;
      }
      seen.add(s.id);
      const key = workspaceName(s.location?.directory, home);
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }
    for (const s of serverHits) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const key = workspaceName(s.location?.directory, home);
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }
    const isRunningId = (id: string) => !!(running[id] || activeIDs.includes(id));
    return [...buckets.entries()]
      .map(([name, list]) => ({
        name,
        list: [...list].sort((a, b) => {
          const ar = isRunningId(a.id);
          const br = isRunningId(b.id);
          if (ar !== br) return Number(br) - Number(ar);
          return b.time.updated - a.time.updated;
        }),
      }))
      .sort((a, b) => {
        const ar = a.list.some((s) => isRunningId(s.id)) ?? false;
        const br = b.list.some((s) => isRunningId(s.id)) ?? false;
        if (ar !== br) return Number(br) - Number(ar);
        return 0;
      });
  }, [sessions, serverHits, normalizedQuery, home, running, activeIDs]);

  // Sessions matched only by message content, not by title/workspace/server.
  const contentOnly = useMemo(() => {
    if (!normalizedQuery || contentHits.size === 0) return [] as SessionInfo[];
    const listed = new Set(groups.flatMap((g) => g.list.map((s) => s.id)));
    const byID = new Map(sessions.map((s) => [s.id, s]));
    const out: SessionInfo[] = [];
    for (const id of contentHits.keys()) {
      if (listed.has(id)) continue;
      const s = byID.get(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.time.updated - a.time.updated).slice(0, CONTENT_GROUP_LIMIT);
  }, [sessions, groups, contentHits, normalizedQuery]);

  const matchedCount = groups.reduce((n, g) => n + g.list.length, 0) + contentOnly.length;

  const toggleHitCollapse = (id: string) => {
    setCollapsedHits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openHit = (sessionID: string, messageID: string) => {
    setHighlightMessage(sessionID, messageID, trimmedQuery);
    void selectSession(sessionID);
    onClose();
  };

  if (!open) return null;

  const tooShort = trimmedQuery.length < SEARCH_DEBOUNCE_MIN_LENGTH;

  const renderSession = (s: SessionInfo) => {
    const hits = contentHits.get(s.id) ?? [];
    const collapsed = collapsedHits.has(s.id);
    return (
      <div key={s.id} className="mb-0.5">
        <Target
          id="sidebar.sessionRow"
          sessionID={s.id}
          title={s.title ?? "Untitled session"}
          updated={s.time.updated}
          active={activeIDs.includes(s.id)}
          selected={s.id === current}
          subagentsActive={subagentActiveParents.has(s.id)}
          onSelect={() => {
            void selectSession(s.id);
            onClose();
          }}
        />
        {hits.length > 0 && (
          <div className="ml-2 border-l border-[var(--border-weak-base)] pl-2">
            <button
              type="button"
              onClick={() => toggleHitCollapse(s.id)}
              className="mb-1 flex w-full cursor-pointer items-center gap-1 text-[10px] text-[var(--text-weaker)] hover:text-[var(--text-weak)]"
            >
              <ChevronDown className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
              {hits.length} {hits.length === 1 ? "message" : "messages"} match{hits.length === 1 ? "" : "es"}
            </button>
            {!collapsed && (
              <div className="flex flex-col gap-1 pb-1">
                {hits.slice(0, HITS_PER_SESSION).map((h: MessageHit) => (
                  <button
                    key={h.messageID}
                    type="button"
                    onClick={() => openHit(s.id, h.messageID)}
                    className="cursor-pointer rounded-md bg-[var(--surface-inset-base)] px-2 py-1 text-left text-xs leading-relaxed text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
                    title="Open session and scroll to message"
                  >
                    <span className="line-clamp-2">
                      {h.snippet.slice(0, h.matchStart)}
                      <mark className="rounded-sm bg-yellow-500/30 px-0.5 font-medium text-[var(--text-strong)]">
                        {h.snippet.slice(h.matchStart, h.matchEnd)}
                      </mark>
                      {h.snippet.slice(h.matchEnd)}
                    </span>
                  </button>
                ))}
                {hits.length > HITS_PER_SESSION && (
                  <span className="px-2 text-[10px] text-[var(--text-weaker)]">
                    +{hits.length - HITS_PER_SESSION} more in this session
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Press-catcher: any pointer press outside the panel dismisses it. */}
      <div className="fixed inset-0 z-50 bg-black/30 animate-in fade-in duration-100" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Search sessions and messages"
        className="fixed top-[8vh] left-1/2 z-50 flex max-h-[78vh] w-[min(44rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-float-base)] shadow-2xl animate-in fade-in slide-in-from-top-4 duration-150"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-3 py-2.5">
          <Search className="size-4 shrink-0 text-[var(--text-weaker)]" />
          <input
            ref={inputRef}
            id="session-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions and messages"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-weaker)]"
          />
          <button
            type="button"
            onClick={() => {
              setQuery("");
              onClose();
            }}
            title="Close search"
            aria-label="Close search"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {tooShort ? (
            <p className="px-2 py-8 text-center text-xs text-[var(--text-weaker)]">
              {trimmedQuery.length === 0
                ? "Search sessions by title, workspace, or message content."
                : "Keep typing…"}
            </p>
          ) : (
            <>
              <p className="px-2 pb-2 text-[10px] text-[var(--text-weaker)]" aria-live="polite">
                {matchedCount} matched
                {contentSearching ? " · searching messages…" : ""}
              </p>
              {groups.length === 0 && contentOnly.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-[var(--text-weak)]">No matches.</p>
              )}
              {groups.map((group) => (
                <section key={group.name} className="mb-3 last:mb-1">
                  <div className="mb-1 flex min-w-0 items-center gap-2 border-b border-[var(--border-weak-base)] px-2 py-1.5">
                    <span className="min-w-0 truncate text-[11px] font-medium tracking-wide text-[var(--text-weaker)] uppercase">
                      {group.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{group.list.length}</span>
                  </div>
                  {group.list.map(renderSession)}
                </section>
              ))}
              {contentOnly.length > 0 && (
                <section className="mb-3 last:mb-1">
                  <div className="mb-1 flex min-w-0 items-center gap-2 border-b border-[var(--border-weak-base)] px-2 py-1.5">
                    <span className="min-w-0 truncate text-[11px] font-medium tracking-wide text-[var(--text-weaker)] uppercase">
                      Message matches
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{contentOnly.length}</span>
                  </div>
                  {contentOnly.map(renderSession)}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
