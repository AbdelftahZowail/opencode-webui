import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Pin, RotateCcw, X } from "lucide-react";
import { Spinner } from "./ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { SessionTabsRail, type SessionTabsRailProps } from "./SessionTabsRail";
import { autoRegister } from "../extensions/registry";
import type { TabIndicators } from "../lib/sessionTabs";

/**
 * The session tab rail — v2's primary workspace chrome (parity.md §5 R3).
 *
 * Rendered by App through `<Target id="session.tabs">`. Presentational: the
 * store slice arrives as `tabs` (built by `lib/sessionTabs.ts`) and every
 * interaction is a callback, so the model stays in the store (AGENTS rule 2)
 * and this unit is wrap/replace-able at its target.
 *
 * Behaviour ported from v2 (`component/session-tabs.tsx`, `-rail.tsx`):
 *  - a number cell, a title that shimmers while busy and marquees on hover;
 *  - per-tab indicators: `!` permission, `?` question, spinner while busy,
 *    unread dot, error colour, completion pulse, attention glow;
 *  - middle-click close, drag-reorder, right-click menu, close/reopen;
 *  - compact one-letter mode (delegated to the rail variant).
 *
 * Split view is kept (§9.2): a tab selects a session in the focused pane; it is
 * orthogonal to the side-by-side panes.
 */

export interface SessionTabsProps extends SessionTabsRailProps {
  /** Horizontal (default) or vertical strip; vertical uses the rail variant. */
  orientation?: "horizontal" | "vertical";
  /** One-letter compact mode (implies the rail variant). */
  compact?: boolean;
  /** false → return null; the sidebar pins take over (see SessionPins). */
  tabsEnabled?: boolean;
}

/** v2's per-tab indicator cluster. */
function TabIndicatorCluster({ ind }: { ind: TabIndicators }) {
  if (!ind.busy && !ind.permission && !ind.question && !ind.error && !ind.unread) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" aria-hidden>
      {ind.permission && (
        <span
          data-oc-tab-indicator="permission"
          className="flex size-4 items-center justify-center rounded-[3px] bg-[color:var(--surface-warning-base)] font-mono text-[10px] font-bold leading-none text-[var(--surface-warning-strong)]"
        >
          !
        </span>
      )}
      {ind.question && (
        <span
          data-oc-tab-indicator="question"
          className="flex size-4 items-center justify-center rounded-[3px] bg-[color:var(--surface-info-base)] font-mono text-[10px] font-bold leading-none text-[var(--surface-info-strong)]"
        >
          ?
        </span>
      )}
      {ind.busy && <Spinner className="size-3 text-[var(--surface-brand-base)]" />}
      {ind.unread && (
        <span
          data-oc-tab-indicator={ind.pulse ? "pulse" : "unread"}
          className={`size-1.5 rounded-full bg-[var(--surface-warning-strong)] ${ind.pulse ? "animate-pulse" : ""}`}
        />
      )}
    </span>
  );
}

/**
 * The title cell: truncates when it fits, and on hover slides to reveal the
 * tail (the "hover marquee") when it overflows. Measured at hover time so no
 * layout work happens per render; the busy state pulses (the "shimmer").
 */
function TabTitle({ text, busy }: { text: string; busy: boolean }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const [duration, setDuration] = useState(0);

  const reveal = () => {
    const box = boxRef.current;
    const inner = textRef.current;
    if (!box || !inner) return;
    const over = inner.scrollWidth - box.clientWidth;
    if (over > 6) {
      setShift(over);
      setDuration(Math.max(700, over * 18));
    }
  };
  const reset = () => {
    setShift(0);
    setDuration(150);
  };

  return (
    <span
      ref={boxRef}
      onMouseEnter={reveal}
      onMouseLeave={reset}
      className="relative block min-w-0 flex-1 overflow-hidden"
    >
      <span
        ref={textRef}
        className={`inline-block max-w-none whitespace-nowrap transition-transform ease-linear ${busy ? "animate-pulse" : ""}`}
        style={{ transform: `translateX(${-shift}px)`, transitionDuration: `${duration}ms` }}
      >
        {text}
      </span>
    </span>
  );
}

export function SessionTabs(props: SessionTabsProps) {
  // Hooks are declared before any early return so the component shape is
  // stable across orientation/empty/disabled branches.
  const dragFrom = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const {
    tabs,
    current,
    orientation = "horizontal",
    compact = false,
    tabsEnabled = true,
    canReopen = false,
    onSelect,
    onClose,
    onReopen,
    onReorder,
    onCloseOthers,
    onCloseAll,
    onToggleTabs,
  } = props;

  const isCurrent = (sessionID: string) => sessionID === current;

  if (!tabsEnabled) return null;
  if (compact || orientation === "vertical") {
    return (
      <SessionTabsRail
        tabs={tabs}
        current={current}
        canReopen={canReopen}
        onSelect={onSelect}
        onClose={onClose}
        onReopen={onReopen}
        onReorder={onReorder}
        onCloseOthers={onCloseOthers}
        onCloseAll={onCloseAll}
        onToggleTabs={onToggleTabs}
      />
    );
  }
  if (tabs.length === 0 && !canReopen && !onToggleTabs) return null;

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    const activeIndex = Math.max(0, tabs.findIndex((t) => isCurrent(t.sessionID)));
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(activeIndex + step + tabs.length) % tabs.length];
      if (next) onSelect(next.sessionID);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      const target = event.key === "Home" ? tabs[0] : tabs[tabs.length - 1];
      if (target) onSelect(target.sessionID);
    }
  };

  return (
    <div
      data-oc-session-tabs
      data-oc-orientation="horizontal"
      data-oc-tab-count={tabs.length}
      role="tablist"
      aria-orientation="horizontal"
      onKeyDown={onTabKeyDown}
      className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto border-b border-[var(--border-base)] bg-[var(--background-base)] px-1 pt-1"
    >
      {tabs.map((tab) => (
        <ContextMenu key={tab.sessionID}>
          <ContextMenuTrigger asChild>
            <div
              role="tab"
              aria-selected={isCurrent(tab.sessionID)}
              tabIndex={isCurrent(tab.sessionID) ? 0 : -1}
              data-oc-tab
              data-oc-tab-id={tab.sessionID}
              data-oc-tab-status={tab.status}
              data-oc-current={isCurrent(tab.sessionID) ? "true" : undefined}
              title={tab.title}
              draggable
              onClick={() => onSelect(tab.sessionID)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  // Middle-click close (v2).
                  e.preventDefault();
                  onClose(tab.sessionID);
                }
              }}
              onMouseDown={(e) => {
                // Suppress the middle-click autoscroll before auxclick.
                if (e.button === 1) e.preventDefault();
              }}
              onDragStart={(e: DragEvent<HTMLDivElement>) => {
                dragFrom.current = tab.index;
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e: DragEvent<HTMLDivElement>) => {
                if (dragFrom.current === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropIndex(tab.index);
              }}
              onDrop={(e: DragEvent<HTMLDivElement>) => {
                e.preventDefault();
                const from = dragFrom.current;
                dragFrom.current = null;
                const to = dropIndex;
                setDropIndex(null);
                if (from !== null && to !== null && from !== to) onReorder?.(from, to);
              }}
              onDragEnd={() => {
                dragFrom.current = null;
                setDropIndex(null);
              }}
              className={`group relative flex min-w-[7rem] max-w-[16rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2 py-1.5 text-xs transition-colors ${
                isCurrent(tab.sessionID)
                  ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                  : "text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
              } ${
                tab.status === "error"
                  ? "text-[var(--surface-critical-strong)]"
                  : ""
              } ${dropIndex === tab.index ? "ring-1 ring-[var(--border-selected)]" : ""} ${
                tab.indicators.attention
                  ? "ring-1 ring-[color-mix(in_oklch,var(--surface-warning-strong)_45%,transparent)]"
                  : ""
              }`}
            >
              <span
                data-oc-tab-number
                className="w-4 shrink-0 text-center font-mono text-[10px] text-[var(--text-weaker)]"
              >
                {tab.number <= 10 ? tab.number : ""}
              </span>
              <TabTitle text={tab.title} busy={tab.indicators.busy} />
              <TabIndicatorCluster ind={tab.indicators} />
              <button
                type="button"
                data-oc-tab-close
                title="Close tab"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.sessionID);
                }}
                className="ml-1 shrink-0 cursor-pointer rounded-sm p-0.5 text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-active)] hover:text-[var(--text-strong)]"
              >
                <X className="size-3" />
              </button>
              {isCurrent(tab.sessionID) && (
                <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-[var(--border-selected)]" />
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-44">
            <ContextMenuItem onSelect={() => onClose(tab.sessionID)}>Close tab</ContextMenuItem>
            <ContextMenuItem
              disabled={tabs.length <= 1}
              onSelect={() => onCloseOthers?.(tab.sessionID)}
            >
              Close other tabs
            </ContextMenuItem>
            <ContextMenuItem disabled={tabs.length <= 1} onSelect={() => onCloseAll?.()}>
              Close all tabs
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!canReopen} onSelect={() => onReopen?.()}>
              Reopen closed tab
            </ContextMenuItem>
            {onToggleTabs && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={onToggleTabs}>Use pins instead of tabs</ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ))}

      <div className="ml-auto flex shrink-0 items-center gap-1 pl-1">
        {canReopen && (
          <button
            type="button"
            data-oc-tab-reopen
            title="Reopen closed tab"
            aria-label="Reopen closed tab"
            onClick={() => onReopen?.()}
            className="cursor-pointer rounded-md p-1 text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <RotateCcw className="size-3.5" />
          </button>
        )}
        {onToggleTabs && (
          <button
            type="button"
            data-oc-tab-toggle-pins
            title="Use pins instead of tabs"
            aria-label="Use pins instead of tabs"
            onClick={onToggleTabs}
            className="cursor-pointer rounded-md p-1 text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <Pin className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// Self-registration (spec §5.3): App renders this through <Target id="session.tabs">.
autoRegister({
  "session.tabs": (p) => <SessionTabs {...(p as unknown as SessionTabsProps)} />,
});
