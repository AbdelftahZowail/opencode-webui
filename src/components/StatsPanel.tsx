import { useMemo } from "react";
import { AlertTriangle, ArrowLeft, BarChart3, Loader2, Menu, RefreshCw } from "lucide-react";
import { openMobileSidebar } from "../store";
import { cn } from "../lib/utils";
import { autoRegister } from "../extensions/registry";
import {
  blockDigits,
  buildCalendar,
  formatCost,
  formatCount,
  formatDay,
  formatInt,
  intensityLevel,
  tokenBreakdown,
  totalTokens,
  type SessionStatsInfo,
} from "../lib/stats";

/**
 * Stats route (R6). Full-screen surface routed at `/stats`, mirroring v2's
 * `/stats` plugin route: the year-to-date token total as giant block digits,
 * a GitHub-style activity calendar, and the year's session/streak/step
 * counters with a footer.
 *
 * Presentational by contract (AGENTS rule 2): it receives the stats slice and
 * an `onRetry` action — it never calls `api.*`. The store owns the fetch and
 * passes the payload through `<Target id="stats.panel">`.
 */
export interface StatsPanelProps {
  data: SessionStatsInfo | null;
  loading: boolean;
  error: string | null;
  /** Re-run the store's fetch (shown in the error state and the header). */
  onRetry?: () => void;
}

/** Cell size (px) + gap must agree with the calendar's `PITCH`. */
const CELL = 10;
const GAP = 3;
const PITCH = CELL + GAP;

/** Five-level intensity scale — token-driven, never hex (AGENTS rule 4). */
const CELL_CLASSES = [
  "bg-[var(--surface-raised-base)]",
  "bg-[color-mix(in_oklch,var(--surface-success-strong)_25%,transparent)]",
  "bg-[color-mix(in_oklch,var(--surface-success-strong)_45%,transparent)]",
  "bg-[color-mix(in_oklch,var(--surface-success-strong)_70%,transparent)]",
  "bg-[var(--surface-success-strong)]",
] as const;

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

export function StatsPanel({ data, loading, error, onRetry }: StatsPanelProps) {
  // The range's own year is authoritative; fall back to the current year
  // before the first payload arrives (the query is Jan 1 of this year).
  const year = data ? new Date(data.range.from).getUTCFullYear() : new Date().getFullYear();
  const calendar = useMemo(
    () => (data ? buildCalendar(data.activity, year) : null),
    [data, year],
  );

  return (
    <div
      data-oc-stats
      className="pane-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="shrink-0 border-b border-[var(--border-base)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openMobileSidebar}
            title="Open sessions"
            aria-label="Open sessions"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)] md:hidden"
          >
            <Menu className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => window.history.back()}
            title="Go back"
            className="hidden shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-1.5 py-0.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)] md:inline-flex"
          >
            <ArrowLeft className="size-3" />
            Back
          </button>
          <BarChart3 className="size-4 shrink-0 text-[var(--text-weaker)]" />
          <span className="truncate text-[var(--font-size-large)] font-medium text-[var(--text-strong)]">
            Stats
          </span>
          {data && (
            <span className="shrink-0 rounded-full border border-[var(--border-weak-base)] px-2 py-0.5 text-[11px] text-[var(--text-weaker)]">
              {year} · year to date
            </span>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={loading}
              title="Refresh stats"
              className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)] disabled:pointer-events-none disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
              Refresh
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-6">
          {error ? (
            <ErrorState message={error} onRetry={onRetry} />
          ) : loading && !data ? (
            <LoadingState />
          ) : data && calendar ? (
            <StatsContent data={data} calendar={calendar} year={year} />
          ) : (
            <EmptyState onRetry={onRetry} />
          )}
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--text-weaker)]">
      <Loader2 className="size-4 animate-spin" /> Loading stats…
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--border-base)] px-6 py-16 text-center">
      <AlertTriangle className="size-6 text-[var(--surface-warning-strong)]" />
      <p className="max-w-md text-sm text-[var(--text-weak)]">
        Could not load stats: {message}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer rounded-md border border-[var(--border-weak-base)] px-3 py-1.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
        >
          Try again
        </button>
      )}
    </div>
  );
}

function EmptyState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--border-base)] px-6 py-16 text-center text-sm text-[var(--text-weaker)]">
      <p>No activity recorded for this year yet.</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer rounded-md border border-[var(--border-weak-base)] px-3 py-1.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
        >
          Refresh
        </button>
      )}
    </div>
  );
}

function StatsContent({
  data,
  calendar,
  year,
}: {
  data: SessionStatsInfo;
  calendar: ReturnType<typeof buildCalendar>;
  year: number;
}) {
  const total = totalTokens(data.tokens);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="flex flex-col gap-8">
      {/* Hero: year-to-date tokens as giant block digits. */}
      <section data-oc-stats-tokens>
        <div className="text-xs font-medium tracking-wide text-[var(--text-weaker)] uppercase">
          Tokens · {year} year to date
        </div>
        <div className="mt-4 overflow-x-auto">
          <pre
            role="img"
            aria-label={`${total} tokens`}
            className="font-mono text-[13px] leading-[1.08] tracking-tight text-[var(--text-strong)] select-all sm:text-base"
          >
            {blockDigits(total).join("\n")}
          </pre>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--text-weaker)]">
          {tokenBreakdown(data.tokens)
            .filter((row) => row.value > 0)
            .map((row) => (
              <span key={row.label}>
                {row.label} <span className="tabular-nums text-[var(--text-weak)]">{formatInt(row.value)}</span>
              </span>
            ))}
        </div>
      </section>

      {/* Year counters. */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Sessions" value={formatInt(data.sessions)} />
        <StatCard label="Subagents" value={formatInt(data.subagents)} />
        <StatCard label="Prompts" value={formatInt(data.prompts)} />
        <StatCard label="Steps" value={formatInt(data.steps)} />
        <StatCard label="Active days" value={formatInt(data.activeDays)} />
        <StatCard
          label="Best streak"
          value={`${formatInt(data.streak)} day${data.streak === 1 ? "" : "s"}`}
        />
        <StatCard label="Cost" value={formatCost(data.cost)} />
        <StatCard label="Models used" value={formatInt(data.models.length)} />
      </section>

      {/* GitHub-style activity calendar. */}
      <section data-oc-stats-calendar>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium text-[var(--text-strong)]">Activity</h2>
          <span className="text-xs text-[var(--text-weaker)]">
            {formatInt(data.steps)} steps across {formatInt(data.activeDays)} active day
            {data.activeDays === 1 ? "" : "s"}
          </span>
        </div>
        <Calendar calendar={calendar} />
      </section>

      {/* Per-model usage (top rows, steps descending). */}
      {data.models.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-[var(--text-strong)]">Models</h2>
          <ul className="mt-2 flex flex-col divide-y divide-[var(--border-base)] border-t border-[var(--border-base)]">
            {[...data.models]
              .sort((a, b) => b.steps - a.steps)
              .slice(0, 8)
              .map((usage) => (
                <li
                  key={`${usage.model.providerID}/${usage.model.id}${usage.model.variant ? `:${usage.model.variant}` : ""}`}
                  className="flex min-w-0 items-center gap-3 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-weak)]">
                    {usage.model.providerID}/{usage.model.id}
                    {usage.model.variant ? ` · ${usage.model.variant}` : ""}
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--text-weaker)]">
                    {formatInt(usage.steps)} steps
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-[var(--text-weak)]">
                    {formatCount(totalTokens(usage.tokens))}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* Footer. */}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-base)] pt-3 text-[11px] text-[var(--text-weaker)]">
        <span>
          {formatDay(data.range.from)} → {formatDay(data.range.to)}
        </span>
        <span aria-hidden>·</span>
        <span title="IANA timezone used for the day buckets">{timezone}</span>
        <span className="ml-auto">Aggregated locally by the OpenCode engine</span>
      </footer>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2.5">
      <div className="text-[11px] tracking-wide text-[var(--text-weaker)] uppercase">{label}</div>
      <div className="mt-1 text-lg font-medium tabular-nums text-[var(--text-strong)]">{value}</div>
    </div>
  );
}

function Calendar({ calendar }: { calendar: ReturnType<typeof buildCalendar> }) {
  const width = calendar.weeks.length * PITCH - GAP;
  return (
    <div className="mt-3 overflow-x-auto pb-1">
      <div className="inline-flex flex-col" style={{ width }}>
        {/* Month labels sit above the column containing the month's first day. */}
        <div className="relative h-4" style={{ width }}>
          {calendar.months.map((month) => (
            <span
              key={month.label}
              className="absolute top-0 text-[10px] text-[var(--text-weaker)]"
              style={{ left: month.weekIndex * PITCH }}
            >
              {month.label}
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          {/* Weekday gutter: Mon / Wed / Fri, aligned to the grid rows. */}
          <div className="grid shrink-0 grid-rows-7" style={{ gap: GAP }}>
            {WEEKDAY_LABELS.map((label, i) => (
              <span
                key={i}
                className="text-[9px] leading-none text-[var(--text-weaker)]"
                style={{ height: CELL, lineHeight: `${CELL}px` }}
              >
                {label}
              </span>
            ))}
          </div>
          {/* Columns = weeks, rows = Sun→Sat. */}
          <div className="grid grid-flow-col grid-rows-7" style={{ gap: GAP }}>
            {calendar.weeks.flatMap((week) =>
              week.days.map((day) => {
                const level = day.inYear ? intensityLevel(day.steps, calendar.maxSteps) : 0;
                return (
                  <span
                    key={day.date}
                    data-oc-stats-day={day.inYear ? day.steps : undefined}
                    title={`${day.date} · ${day.steps} step${day.steps === 1 ? "" : "s"}`}
                    className={cn(
                      "rounded-[2px]",
                      CELL_CLASSES[level],
                      !day.inYear && "invisible",
                    )}
                    style={{ width: CELL, height: CELL }}
                  />
                );
              }),
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--text-weaker)]">
          <span>Less</span>
          {CELL_CLASSES.map((cls, i) => (
            <span
              key={i}
              className={cn("rounded-[2px]", cls)}
              style={{ width: CELL, height: CELL }}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "stats.panel": (p) => <StatsPanel {...(p as unknown as StatsPanelProps)} />,
});
