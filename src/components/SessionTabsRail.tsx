import { useRef, useState, type DragEvent } from "react";
import { Pin, RotateCcw, X } from "lucide-react";
import { Spinner } from "./ui";
import type { TabIndicators, TabRef } from "../lib/sessionTabs";

/**
 * The COMPACT / VERTICAL tab rail (parity.md §5 R3: "compact one-letter mode").
 *
 * Rendered inside `SessionTabs` when the caller asks for `orientation:
 * "vertical"` or `compact: true`. It is deliberately NOT its own registered
 * target: the composition seam for both orientations is the single
 * `session.tabs` target that `SessionTabs` provides (a wrap/replace there
 * covers the rail too). Adding a second id would be a contract change without
 * a consumer — same reasoning as `SessionUnseenBadge` (see its header note).
 *
 * Presentational only: every value arrives as a prop, every interaction calls
 * a callback. No store, no fetching.
 */

export interface SessionTabsRailProps {
  tabs: TabRef[];
  current: string | null;
  canReopen?: boolean;
  onSelect: (sessionID: string) => void;
  onClose: (sessionID: string) => void;
  onReopen?: () => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onCloseOthers?: (sessionID: string) => void;
  onCloseAll?: () => void;
  onToggleTabs?: () => void;
}

/** Shared indicator cluster (number/letter cells both use it). */
function IndicatorCluster({ ind }: { ind: TabIndicators }) {
  if (!ind.busy && !ind.permission && !ind.question && !ind.error && !ind.unread) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {ind.permission && (
        <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-[color:var(--surface-warning-base)] font-mono text-[9px] font-bold leading-none text-[var(--surface-warning-strong)]">!</span>
      )}
      {ind.question && (
        <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-[color:var(--surface-info-base)] font-mono text-[9px] font-bold leading-none text-[var(--surface-info-strong)]">?</span>
      )}
      {ind.busy && <Spinner className="size-3 text-[var(--surface-brand-base)]" />}
      {ind.unread && (
        <span className={`size-1.5 rounded-full bg-[var(--surface-warning-strong)] ${ind.pulse ? "animate-pulse" : ""}`} />
      )}
    </span>
  );
}

export function SessionTabsRail({
  tabs,
  current,
  canReopen = false,
  onSelect,
  onClose,
  onReopen,
  onReorder,
  onToggleTabs,
}: SessionTabsRailProps) {
  const dragFrom = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (tabs.length === 0 && !canReopen && !onToggleTabs) return null;

  const isCurrent = (sessionID: string) => sessionID === current;

  return (
    <div
      data-oc-session-tabs-rail
      data-oc-orientation="vertical"
      role="tablist"
      aria-orientation="vertical"
      className="flex w-full min-w-0 flex-col gap-0.5 border-r border-[var(--border-base)] p-1"
    >
      {tabs.map((tab) => (
        <div
          key={tab.sessionID}
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
              e.preventDefault();
              onClose(tab.sessionID);
            }
          }}
          onMouseDown={(e) => {
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
          className={`group relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors ${
            isCurrent(tab.sessionID)
              ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
              : "text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          } ${dropIndex === tab.index ? "ring-1 ring-[var(--border-selected)]" : ""} ${
            tab.indicators.attention ? "ring-1 ring-[color-mix(in_oklch,var(--surface-warning-strong)_45%,transparent)]" : ""
          }`}
        >
          <span className="w-3 shrink-0 text-center font-mono text-[10px] text-[var(--text-weaker)]" data-oc-tab-number>
            {tab.number}
          </span>
          <span
            className={`flex size-4 shrink-0 items-center justify-center rounded-[3px] font-mono text-[10px] font-semibold ${
              tab.status === "error"
                ? "bg-[color:var(--surface-critical-base)] text-[var(--surface-critical-strong)]"
                : "bg-[var(--surface-base)] text-[var(--text-base)]"
            }`}
          >
            {tab.letter}
          </span>
          <span className="min-w-0 flex-1">
            <IndicatorCluster ind={tab.indicators} />
          </span>
          <button
            type="button"
            data-oc-tab-close
            title="Close tab"
            aria-label={`Close ${tab.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.sessionID);
            }}
            className="invisible shrink-0 cursor-pointer rounded-sm p-0.5 text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)] group-hover:visible"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {(canReopen || onToggleTabs) && (
        <div className="mt-0.5 flex items-center justify-center gap-1 border-t border-[var(--border-weak-base)] pt-1">
          {canReopen && (
            <button
              type="button"
              title="Reopen closed tab"
              aria-label="Reopen closed tab"
              onClick={() => onReopen?.()}
              className="cursor-pointer rounded-sm p-1 text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
            >
              <RotateCcw className="size-3" />
            </button>
          )}
          {onToggleTabs && (
            <button
              type="button"
              title="Use pins instead of tabs"
              aria-label="Use pins instead of tabs"
              onClick={onToggleTabs}
              className="cursor-pointer rounded-sm p-1 text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
            >
              <Pin className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
