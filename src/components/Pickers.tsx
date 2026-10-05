import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import type { AgentInfo, ModelInfo, ModelRef } from "../api/types";
import {
  loadSessionDetail,
  refreshSessions,
  switchAgent,
  switchModel,
  useStore,
} from "../store";
import { AlertTriangle, RotateCcw, Search, Star, X } from "lucide-react";
import { formatModelRef } from "../lib/modelLabel";
import {
  type CatalogStatus,
  ensureModels,
  getCatalogStatus,
  getModels,
  subscribeCatalog,
} from "../lib/modelCatalog";
import {
  clearNotice,
  getAvailableRecents,
  getMemoryVersion,
  getNotice,
  getPinnedDefault,
  resolveNewSessionModel,
  setPinnedDefault,
  subscribeModelMemory,
} from "../lib/modelMemory";
import { Button } from "./ui";

/**
 * Anchored menu that escapes `overflow` clipping. The composer meta-row is a
 * horizontal scroller (`overflow-x-auto`), and CSS forces `overflow-y` to
 * `auto` alongside it — an inline absolutely-positioned dropdown opens
 * *outside* that box and gets clipped, so a click looks dead. While `open`,
 * the caller renders the menu in a fixed-position portal on `document.body`,
 * aligned to the trigger (above when `openUp`, else below; `align` picks the
 * left/right edge) and clamped to the viewport. Position follows the trigger
 * across resize/scroll. Outside mousedown closes; clicks inside the portaled
 * menu count as inside.
 */
function useAnchoredMenu({
  open,
  onClose,
  openUp,
  align,
  width,
}: {
  open: boolean;
  onClose: () => void;
  openUp: boolean;
  align: "left" | "right";
  width: number;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // A hidden anchor (display:none — e.g. the mobile composer meta-row
    // collapsing while another field has focus) reports a zero rect; keep the
    // last good position instead of pinning the menu to the viewport edge or
    // off-screen. The menu reappears where it was once the anchor returns.
    if (r.width === 0 && r.height === 0) return;
    const gap = 4;
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(align === "right" ? r.right - width : r.left, window.innerWidth - width - margin),
    );
    const next: CSSProperties = { position: "fixed", left };
    if (openUp) next.bottom = window.innerHeight - r.top + gap;
    else next.top = r.bottom + gap;
    setStyle(next);
  }, [openUp, align, width]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return { anchorRef, menuRef, style };
}

/**
 * Keyboard owner for an open hand-rolled menu (RunsPanel capture pattern):
 * while `open`, a window CAPTURE-phase listener routes ↑/↓ (wrap), Home/End,
 * Enter (select), Tab/Esc (close; Esc stops propagation so the site-wide
 * interrupt never fires) and printable-char typeahead. Highlight resets on
 * open; the selected row auto-scrolls into view inside the listbox, and the
 * returned mouse handler keeps the highlight under the pointer even after
 * scrolls (per-row mouseenter alone goes stale when rows move underneath a
 * stationary pointer).
 *
 * Pass `query`/`onQueryChange` to attach a filter input (ModelPicker):
 * printable keys then belong to the input — typeahead is suppressed — the
 * highlight restarts at the top whenever the query changes, Esc clears a
 * non-empty query before closing, and Esc/Tab still work when the filtered
 * list is empty (arrows/Enter/typeahead stay inert at count 0).
 */
function useMenuKeys({
  open,
  onClose,
  count,
  onSelect,
  listId,
  query,
  onQueryChange,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  onSelect: (index: number) => void;
  listId: string;
  query?: string;
  onQueryChange?: (next: string) => void;
}): [number, (i: number) => void, (e: ReactMouseEvent<HTMLElement>) => void] {
  const [highlight, setHighlight] = useState(0);
  const highlightRef = useRef(0);
  highlightRef.current = highlight;
  const typeaheadRef = useRef({ prefix: "", at: 0 });

  // Reset on open; with a filter, every query change restarts the highlight
  // at the top of the freshly-filtered rows.
  useEffect(() => {
    if (open) setHighlight(0);
  }, [open, query]);

  // Follow the highlight: the listbox clips at max-h; without this, ↓ past
  // the fold loses the selection out of view ("it goes away").
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listId}-item-${highlight}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, listId]);

  // Mouse tracking at the listbox level: compute the row under the pointer
  // on every move, so hover stays correct even after the list scrolled.
  function onListMouseMove(e: ReactMouseEvent<HTMLElement>) {
    const container = e.currentTarget;
    const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
    for (const el of options) {
      const r = el.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY < r.bottom) {
        setHighlight(options.indexOf(el));
        return;
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    // Typeahead reads item labels from the open listbox's buttons, captured
    // once per open so repeated keystrokes don't re-query the DOM.
    let labels: string[] | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        // With a filter input, Esc first clears a non-empty query; the next
        // Esc (or Tab) closes as usual.
        if (e.key === "Escape" && onQueryChange && query) {
          onQueryChange("");
          return;
        }
        onClose();
        return;
      }
      if (count === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((i) => (i + 1) % count);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((i) => (i <= 0 ? count - 1 : i - 1));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight(count - 1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onSelect(highlightRef.current < count ? highlightRef.current : 0);
        return;
      }
      // A filter input owns printable keys while it's active — no typeahead
      // (the characters flow into the input and filter the rows instead).
      if (onQueryChange) return;
      // Typeahead: jump to the first following item whose label starts with
      // the accumulated prefix; repeated keys inside ~1s extend it.
      const ch = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey ? e.key.toLowerCase() : null;
      if (!ch) return;
      const now = Date.now();
      const t = typeaheadRef.current;
      const prefix = now - t.at < 1000 ? t.prefix + ch : ch;
      t.prefix = prefix;
      t.at = now;
      labels ??= Array.from(
        document.querySelectorAll<HTMLButtonElement>(`#${listId} > button`),
      ).map((b) => (b.textContent ?? "").trim().toLowerCase());
      setHighlight((current) => {
        for (let off = 1; off <= count; off++) {
          const idx = (current + off) % count;
          if ((labels?.[idx] ?? "").startsWith(prefix)) return idx;
        }
        return current;
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, count, onClose, onSelect, listId, query, onQueryChange]);

  return [highlight, setHighlight, onListMouseMove];
}

async function defaultAgent(): Promise<AgentInfo | undefined> {
  try {
    const agents = await api.agents();
    return agents.find((a) => a.mode === "primary" && !a.hidden) ?? agents[0];
  } catch {
    return undefined;
  }
}

export function useSessionDetail(sessionID: string) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID));
  const detail = useStore((s) => s.sessionDetails[sessionID]);
  useEffect(() => {
    void loadSessionDetail(sessionID);
  }, [sessionID]);
  return { session, detail };
}

/** Re-render trigger for model memory changes (recents, pin, notice). */
function useModelMemoryVersion(): number {
  const [version, setVersion] = useState(getMemoryVersion);
  useEffect(() => {
    const unsub = subscribeModelMemory(() => setVersion(getMemoryVersion()));
    setVersion(getMemoryVersion());
    return unsub;
  }, []);
  return version;
}

/** Shared prefetched model catalog, kept in sync with the module cache. */
function useModelCatalog(): { models: ModelInfo[]; status: CatalogStatus } {
  const [snap, setSnap] = useState(() => ({ models: getModels(), status: getCatalogStatus() }));
  useEffect(() => {
    const sync = () => setSnap({ models: getModels(), status: getCatalogStatus() });
    sync();
    const unsub = subscribeCatalog(sync);
    void ensureModels();
    return unsub;
  }, []);
  return snap;
}

const ITEM_CLASSES =
  "flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left transition-colors hover:bg-[color:var(--surface-base-hover)] data-[hl=true]:bg-[color:var(--surface-raised-base-active)]";

/** Sticky section header for the model picker's recents / provider groups. */
const SECTION_CLASSES =
  "sticky top-0 z-10 bg-[color:var(--surface-float-base)] px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-wide text-[color:var(--text-weaker)]";

export function ModelPicker({
  sessionID,
  openUp = false,
  align = "right",
}: {
  sessionID: string;
  openUp?: boolean;
  align?: "left" | "right";
}) {
  const { session, detail } = useSessionDetail(sessionID);
  const pendingModel = useStore((s) => s.pendingModels[sessionID] ?? null);
  const memVersion = useModelMemoryVersion();
  const { models, status } = useModelCatalog();
  const [open, setOpen] = useState(false);
  const [fallback, setFallback] = useState<ModelRef | null>(null);
  const { anchorRef, menuRef, style: menuStyle } = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    openUp,
    align,
    width: 288,
  });
  const signal = useStore((s) => s.uiSignals.models);

  // /models (and the command palette) request this picker to open.
  useEffect(() => {
    if (signal) setOpen(true);
  }, [signal]);

  const enabledModels = useMemo(() => models.filter((m) => m.enabled), [models]);
  const listId = "menu-models";

  function fuzzyScore(query: string, haystack: string): number | null {
    if (haystack.includes(query)) {
      const start = haystack.indexOf(query);
      let s = 1000 - start * 2;
      if (start === 0 || haystack[start - 1] === " " || haystack[start - 1] === "/" || haystack[start - 1] === "-") s += 20;
      return s;
    }
    let qi = 0;
    let lastIdx = -2;
    let gaps = 0;
    let contiguous = 0;
    let maxRun = 0;
    let run = 0;
    let boundaryHits = 0;
    for (let hi = 0; hi < haystack.length && qi < query.length; hi++) {
      if (haystack[hi] === query[qi]) {
        if (hi === 0 || haystack[hi - 1] === " " || haystack[hi - 1] === "/" || haystack[hi - 1] === "-") boundaryHits++;
        if (lastIdx + 1 === hi) {
          contiguous++;
          run++;
          maxRun = Math.max(maxRun, run);
        } else {
          gaps += hi - lastIdx - 1;
          run = 1;
        }
        lastIdx = hi;
        qi++;
      }
    }
    if (qi !== query.length) return null;
    return 500 - lastIdx * 0.5 - gaps * 2 + contiguous * 10 + boundaryHits * 2 + maxRun * 3;
  }

  // Filter query lives only while the menu is open (reset on every open).
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const searched = useMemo(() => {
    if (!q) return enabledModels;
    const scored: { m: ModelInfo; s: number; i: number }[] = [];
    for (let i = 0; i < enabledModels.length; i++) {
      const m = enabledModels[i]!;
      const hay = `${m.name} ${m.modelID} ${m.providerID} ${m.id}`.toLowerCase();
      const s = fuzzyScore(q, hay);
      if (s !== null) scored.push({ m, s, i });
    }
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    return scored.map((x) => x.m);
  }, [enabledModels, q]);

  // Recents (newest first) only when not filtering; the rest keep catalog
  // order, or are provider-grouped when the enabled list is long enough.
  const grouped = !q && enabledModels.length > 8;
  const recentModels = useMemo(
    () => (q ? [] : getAvailableRecents(enabledModels)),
    [enabledModels, q, memVersion],
  );
  const ordered = useMemo(() => {
    if (q) return searched;
    const byKey = new Map(enabledModels.map((m) => [`${m.providerID}/${m.modelID}`, m]));
    const recentInfos: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const ref of recentModels) {
      const m = byKey.get(`${ref.providerID}/${ref.id}`);
      if (!m) continue;
      recentInfos.push(m);
      seen.add(`${m.providerID}/${m.modelID}`);
    }
    let rest = searched.filter((m) => !seen.has(`${m.providerID}/${m.modelID}`));
    if (grouped) {
      rest = [...rest].sort(
        (a, b) => a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name),
      );
    }
    return [...recentInfos, ...rest];
  }, [q, searched, recentModels, enabledModels, grouped]);
  const recentCount = q ? 0 : recentModels.length;

  const inputRef = useRef<HTMLInputElement>(null);
  // Fresh open: unfiltered.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  // The search box lives in a portal that only exists once `useAnchoredMenu`
  // has measured the trigger (`menuStyle` flips null → set exactly once per
  // open). Focusing on `open` alone ran before the input mounted, so the
  // caret never landed in the field — key the focus on the portal being
  // mounted instead.
  const inputMounted = !!menuStyle;
  useEffect(() => {
    if (open && inputMounted) inputRef.current?.focus();
  }, [open, inputMounted]);

  const current: ModelRef | undefined =
    pendingModel ?? detail?.model ?? session?.model ?? fallback ?? undefined;

  // A session with no model of its own (fresh draft, or legacy unpinned) shows
  // what the memory cascade would resolve at draft-open time. An explicit
  // pending/session model always wins; the effect only runs while `current` is
  // undefined, so it never fights a real selection.
  useEffect(() => {
    if (current) return;
    let live = true;
    void resolveNewSessionModel(models.length ? models : undefined).then((m) => {
      if (live && m) setFallback(m);
    });
    return () => {
      live = false;
    };
  }, [current, models]);

  const pickModel = (index: number) => {
    const m = ordered[index];
    if (!m) return;
    void switchModel(sessionID, { id: m.modelID, providerID: m.providerID }).then(refreshSessions);
    setOpen(false);
  };

  const [highlight, , onListMouseMove] = useMenuKeys({
    open,
    onClose: () => setOpen(false),
    count: ordered.length,
    onSelect: pickModel,
    listId,
    query,
    onQueryChange: setQuery,
  });

  const pinned = getPinnedDefault();
  const notice = getNotice();
  const noticeFallback = notice?.fallback ?? null;
  const sameModel = (ref: ModelRef, m: ModelInfo) =>
    ref.id === m.modelID && ref.providerID === m.providerID;

  function renderRow(m: ModelInfo, index: number) {
    const isCurrent = current ? sameModel(current, m) : false;
    const isPinned = pinned ? sameModel(pinned, m) : false;
    return (
      <button
        key={`${m.providerID}/${m.modelID}`}
        id={`${listId}-item-${index}`}
        type="button"
        role="option"
        aria-selected={isCurrent}
        data-hl={index === highlight || undefined}
        className={ITEM_CLASSES}
        onClick={() => pickModel(index)}
      >
        <span className="min-w-0 truncate">
          <span className="font-mono text-[color:var(--text-strong)]">{m.name}</span>
          <span className="ml-2 font-mono text-[color:var(--text-weaker)]">{m.providerID}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {isPinned && (
            <span title="Default for new sessions" className="text-[color:var(--surface-brand-base)]">
              ★
            </span>
          )}
          {isCurrent && <span className="text-emerald-500">✓</span>}
        </span>
      </button>
    );
  }

  // Rows are emitted as DIRECT children of the listbox so the keyboard owner's
  // typeahead (`#${listId} > button`) and mouse→index mapping stay valid;
  // section headers are plain divs (never `role="option"`).
  function renderRows() {
    if (q) return ordered.map((m, i) => renderRow(m, i));
    const out: ReactNode[] = [];
    let index = 0;
    if (recentCount > 0) {
      out.push(
        <div key="hdr-recent" className={SECTION_CLASSES}>
          Recent
        </div>,
      );
      for (let i = 0; i < recentCount && index < ordered.length; i++, index++) {
        const m = ordered[index];
        if (m) out.push(renderRow(m, index));
      }
      if (index < ordered.length) {
        out.push(
          <div key="hdr-more" className={SECTION_CLASSES}>
            More models
          </div>,
        );
      }
    }
    let lastProvider: string | null = null;
    for (; index < ordered.length; index++) {
      const m = ordered[index];
      if (!m) continue;
      if (grouped && m.providerID !== lastProvider) {
        lastProvider = m.providerID;
        out.push(
          <div key={`hdr-${m.providerID}`} className={SECTION_CLASSES}>
            {m.providerID}
          </div>,
        );
      }
      out.push(renderRow(m, index));
    }
    return out;
  }

  const loading = models.length === 0 && (status === "idle" || status === "loading");
  const errored = models.length === 0 && status === "error";

  return (
    <div ref={anchorRef} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Switch model"
        className="h-7 max-w-48 gap-1 px-2 font-mono text-[11px]"
      >
        <span className="truncate">
          {current ? formatModelRef(current) : "model"}
        </span>
      </Button>
      {open && menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            style={menuStyle}
            className="z-50 w-72 overflow-hidden rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl"
          >
            <div
              data-keyboard-ignore
              className="flex h-8 shrink-0 items-center gap-2 border-b border-[color:var(--border-weak-base)] px-2.5"
            >
              <Search className="size-3.5 shrink-0 text-[color:var(--text-weaker)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter models…"
                aria-label="Filter models"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="h-full w-full bg-transparent font-mono text-[11px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-weaker)]"
              />
            </div>
            {notice && (
              <div
                data-oc-model-notice
                className="flex items-start gap-2 border-b border-[color:var(--border-weak-base)] bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
              >
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 flex-1">
                  {notice.role === "pinned" ? "Pinned" : "Last used"} model{" "}
                  <span className="font-mono">{formatModelRef(notice.ref)}</span> is unavailable
                  {noticeFallback ? (
                    <>
                      {" "}
                      — using <span className="font-mono">{formatModelRef(noticeFallback)}</span>.
                    </>
                  ) : (
                    "."
                  )}
                </span>
                {noticeFallback && (
                  <button
                    type="button"
                    className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
                    onClick={() => setPinnedDefault(noticeFallback)}
                  >
                    Pin it
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={() => clearNotice()}
                  className="shrink-0 opacity-70 hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            )}
            <div
              id={listId}
              role="listbox"
              aria-label="Switch model"
              aria-activedescendant={ordered.length > 0 ? `${listId}-item-${highlight}` : undefined}
              className="max-h-72 overflow-y-auto"
              onMouseMove={onListMouseMove}
            >
              {loading ? (
                <div className="px-3 py-4 text-center text-xs text-[color:var(--text-weaker)]">
                  Loading models…
                </div>
              ) : errored ? (
                <div className="flex flex-col items-center gap-1 px-3 py-4 text-center text-xs text-[color:var(--text-weaker)]">
                  <span>Couldn't load models.</span>
                  <button
                    type="button"
                    className="font-medium text-[color:var(--surface-brand-base)] underline underline-offset-2"
                    onClick={() => void ensureModels()}
                  >
                    Retry
                  </button>
                </div>
              ) : ordered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-[color:var(--text-weaker)]">
                  No matching models
                </div>
              ) : (
                renderRows()
              )}
            </div>
            <div data-oc-model-footer className="border-t border-[color:var(--border-weak-base)]">
              <button
                type="button"
                data-oc-model-default
                disabled={!current}
                onClick={() => current && setPinnedDefault(current)}
                title={current ? `Use ${formatModelRef(current)} for new sessions` : undefined}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-[color:var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Star className="size-3 shrink-0" />
                <span className="shrink-0">Set as default</span>
                {current && (
                  <span className="min-w-0 truncate font-mono text-[color:var(--text-weaker)]">
                    {formatModelRef(current)}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-oc-model-reset
                disabled={!pinned}
                onClick={() => setPinnedDefault(null)}
                title={
                  pinned
                    ? `Currently pinned to ${formatModelRef(pinned)}`
                    : "Already using the engine default"
                }
                className="flex w-full items-center gap-2 border-t border-[color:var(--border-weak-base)] px-3 py-2 text-left text-[11px] text-[color:var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RotateCcw className="size-3 shrink-0" />
                <span className="shrink-0">Reset to engine default</span>
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function VariantPicker({
  sessionID,
  openUp = false,
  align = "right",
}: {
  sessionID: string;
  openUp?: boolean;
  align?: "left" | "right";
}) {
  const { session, detail } = useSessionDetail(sessionID);
  const pendingModel = useStore((s) => s.pendingModels[sessionID] ?? null);
  const [open, setOpen] = useState(false);
  const { models } = useModelCatalog();
  const { anchorRef, menuRef, style: menuStyle } = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    openUp,
    align,
    width: 192,
  });
  const signal = useStore((s) => s.uiSignals.variants);

  // /variants requests this picker to open.
  useEffect(() => {
    if (signal) setOpen(true);
  }, [signal]);

  const current: ModelRef | undefined = pendingModel ?? detail?.model ?? session?.model;

  // This picker decides whether to render at all from the model catalog, so the
  // catalog must be loaded before the trigger can exist (deadlock otherwise).
  // The shared catalog is prefetched at boot and kept in sync here.
  const model = models.find(
    (m) => m.enabled && m.modelID === current?.id && m.providerID === current?.providerID,
  );
  const variants = model?.variants ?? [];
  // The service persists the unset state as variant:"default".
  const activeVariant = current?.variant && current.variant !== "default" ? current.variant : undefined;

  function pick(variant?: string) {
    void switchModel(sessionID, {
      id: current!.id,
      providerID: current!.providerID,
      ...(variant ? { variant } : {}),
    });
    setOpen(false);
  }

  const listId = "menu-variants";
  const itemCount = variants.length + 1;

  const pickIndex = (index: number) => {
    if (index === 0) pick();
    else pick(variants[index - 1]?.id);
  };

  const [highlight, , onListMouseMove] = useMenuKeys({
    open,
    onClose: () => setOpen(false),
    count: itemCount,
    onSelect: pickIndex,
    listId,
  });

  // TUI parity (app.tsx): /variants is hidden entirely when the current model
  // has no variants.
  if (!current || variants.length === 0) return null;

  return (
    <div ref={anchorRef} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Switch model variant"
        className="h-7 max-w-20 px-2 font-mono text-[11px]"
      >
        <span className="truncate">{activeVariant ? `@${activeVariant}` : "@default"}</span>
      </Button>
      {open && menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label="Switch model variant"
            aria-activedescendant={`${listId}-item-${highlight}`}
            style={menuStyle}
            className="z-50 max-h-80 w-48 overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl"
            onMouseMove={onListMouseMove}
          >
            <button
              id={`${listId}-item-0`}
              type="button"
              role="option"
              aria-selected={!activeVariant}
              data-hl={highlight === 0 || undefined}
              className={ITEM_CLASSES}
              onClick={() => pick()}
            >
              <span className="text-[color:var(--text-strong)]">Default</span>
              {!activeVariant && <span className="text-emerald-500">✓</span>}
            </button>
            {variants.map((v, i) => (
              <button
                key={v.id}
                id={`${listId}-item-${i + 1}`}
                type="button"
                role="option"
                aria-selected={activeVariant === v.id}
                data-hl={highlight === i + 1 || undefined}
                className={`${ITEM_CLASSES} font-mono text-xs`}
                onClick={() => pick(v.id)}
              >
                <span className="text-[color:var(--text-strong)]">{v.id}</span>
                {activeVariant === v.id && <span className="text-emerald-500">✓</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function AgentPicker({
  sessionID,
  openUp = false,
  align = "right",
}: {
  sessionID: string;
  openUp?: boolean;
  align?: "left" | "right";
}) {
  const { session, detail } = useSessionDetail(sessionID);
  const pendingAgent = useStore((s) => s.pendingAgent);
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [fallback, setFallback] = useState<string | null>(null);
  const { anchorRef, menuRef, style: menuStyle } = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    openUp,
    align,
    width: 240,
  });
  const signal = useStore((s) => s.uiSignals.agents);

  // /agents requests this picker to open.
  useEffect(() => {
    if (signal) setOpen(true);
  }, [signal]);

  // Only PRIMARY (top-level) agents are switchable from the composer —
  // subagent-mode entries are engine task personas, not session agents.
  const visibleAgents = useMemo(
    () => agents.filter((a) => a.mode === "primary" && !a.hidden),
    [agents],
  );
  const listId = "menu-agents";

  const current: string | undefined = pendingAgent ?? detail?.agent ?? session?.agent ?? fallback ?? undefined;

  useEffect(() => {
    if (open && agents.length === 0) void api.agents().then(setAgents);
  }, [open, agents.length]);

  useEffect(() => {
    if (!session?.agent && fallback === null) {
      void defaultAgent().then((a) => {
        if (a) setFallback(a.id);
      });
    }
  }, [session?.agent, fallback]);

  const pickAgent = (index: number) => {
    const a = visibleAgents[index];
    if (!a) return;
    void switchAgent(sessionID, a.id).then(refreshSessions);
    setOpen(false);
  };

  const [highlight, , onListMouseMove] = useMenuKeys({
    open,
    onClose: () => setOpen(false),
    count: visibleAgents.length,
    onSelect: pickAgent,
    listId,
  });

  return (
    <div ref={anchorRef} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Switch agent (Tab)"
        className="h-7 max-w-28 px-2 text-[11px]"
      >
        <span className="truncate">{current ?? "agent"}</span>
      </Button>
      {open && menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label="Switch agent"
            aria-activedescendant={`${listId}-item-${highlight}`}
            style={menuStyle}
            className="z-50 max-h-80 w-60 overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl"
            onMouseMove={onListMouseMove}
          >
            {visibleAgents.map((a, i) => (
              <button
                key={a.id}
                id={`${listId}-item-${i}`}
                type="button"
                role="option"
                aria-selected={current === a.id}
                data-hl={i === highlight || undefined}
                className={ITEM_CLASSES}
                onClick={() => pickAgent(i)}
              >
                <span className="text-[color:var(--text-strong)]">{a.name}</span>
                {current === a.id && <span className="text-emerald-500">✓</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
