import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api } from "../api/client";
import type { AgentInfo, ModelInfo, ModelRef } from "../api/types";
import {
  loadSessionDetail,
  refreshSessions,
  resolveDefaultModel,
  switchAgent,
  switchModel,
  useStore,
} from "../store";
import { Search } from "lucide-react";
import { formatModelRef } from "../lib/modelLabel";
import { Button } from "./ui";

function useMenu(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose]);
  return ref;
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

const ITEM_CLASSES =
  "flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left transition-colors hover:bg-[color:var(--surface-base-hover)] data-[hl=true]:bg-[color:var(--surface-raised-base-active)]";

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
  const pendingModel = useStore((s) => s.pendingModel);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [fallback, setFallback] = useState<ModelRef | null>(null);
  const ref = useMenu(() => setOpen(false));
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
  const filteredModels = useMemo(() => {
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

  const inputRef = useRef<HTMLInputElement>(null);
  // Fresh open: unfiltered, caret in the search box.
  useEffect(() => {
    if (open) {
      setQuery("");
      inputRef.current?.focus();
    }
  }, [open]);

  const current: ModelRef | undefined =
    pendingModel ?? detail?.model ?? session?.model ?? fallback ?? undefined;

  useEffect(() => {
    if (open && models.length === 0) void api.models().then(setModels);
  }, [open, models.length]);

  useEffect(() => {
    if (!session?.model && fallback === null) {
      void resolveDefaultModel().then((m) => {
        if (m) setFallback(m);
      });
    }
  }, [session?.model, fallback]);

  const pickModel = (index: number) => {
    const m = filteredModels[index];
    if (!m) return;
    void switchModel(sessionID, { id: m.modelID, providerID: m.providerID }).then(refreshSessions);
    setOpen(false);
  };

  const [highlight, , onListMouseMove] = useMenuKeys({
    open,
    onClose: () => setOpen(false),
    count: filteredModels.length,
    onSelect: pickModel,
    listId,
    query,
    onQueryChange: setQuery,
  });

  const menuPos = `${openUp ? "bottom-full mb-1" : "mt-1"} ${align === "right" ? "right-0" : "left-0"}`;

  return (
    <div ref={ref} className="relative">
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
      {open && (
        <div
          className={`absolute z-40 w-72 overflow-hidden rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl ${menuPos}`}
        >
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[color:var(--border-weak-base)] px-2.5">
            <Search className="size-3.5 shrink-0 text-[color:var(--text-weaker)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter models…"
              aria-label="Filter models"
              autoComplete="off"
              spellCheck={false}
              className="h-full w-full bg-transparent font-mono text-[11px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-weaker)]"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Switch model"
            aria-activedescendant={filteredModels.length > 0 ? `${listId}-item-${highlight}` : undefined}
            className="max-h-72 overflow-y-auto"
            onMouseMove={onListMouseMove}
          >
            {filteredModels.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-[color:var(--text-weaker)]">
                No matching models
              </div>
            ) : (
              filteredModels.map((m, i) => (
                <button
                  key={`${m.providerID}/${m.modelID}`}
                  id={`${listId}-item-${i}`}
                  type="button"
                  role="option"
                  aria-selected={current?.id === m.modelID && current?.providerID === m.providerID}
                  data-hl={i === highlight || undefined}
                  className={ITEM_CLASSES}
                  onClick={() => pickModel(i)}
                >
                  <span>
                    <span className="font-mono text-[color:var(--text-strong)]">{m.name}</span>
                    <span className="ml-2 font-mono text-[color:var(--text-weaker)]">{m.providerID}</span>
                  </span>
                  {current?.id === m.modelID && current?.providerID === m.providerID && (
                    <span className="text-emerald-500">✓</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
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
  const pendingModel = useStore((s) => s.pendingModel);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const ref = useMenu(() => setOpen(false));
  const signal = useStore((s) => s.uiSignals.variants);

  // /variants requests this picker to open.
  useEffect(() => {
    if (signal) setOpen(true);
  }, [signal]);

  useEffect(() => {
    if (open && models.length === 0) void api.models().then(setModels);
  }, [open, models.length]);

  const current: ModelRef | undefined = pendingModel ?? detail?.model ?? session?.model;
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

  const menuPos = `${openUp ? "bottom-full mb-1" : "mt-1"} ${align === "right" ? "right-0" : "left-0"}`;

  return (
    <div ref={ref} className="relative">
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
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Switch model variant"
          aria-activedescendant={`${listId}-item-${highlight}`}
          className={`absolute z-40 max-h-80 w-48 overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl ${menuPos}`}
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
        </div>
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
  const ref = useMenu(() => setOpen(false));
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

  const menuPos = `${openUp ? "bottom-full mb-1" : "mt-1"} ${align === "right" ? "right-0" : "left-0"}`;

  return (
    <div ref={ref} className="relative">
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
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Switch agent"
          aria-activedescendant={`${listId}-item-${highlight}`}
          className={`absolute z-40 max-h-80 w-60 overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl ${menuPos}`}
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
        </div>
      )}
    </div>
  );
}
