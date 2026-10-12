/**
 * Stats route (R6) — pure types + helpers. No DOM, no React.
 *
 * The response types mirror the engine's `SessionStats.*` schemas
 * (`docs/reference/openapi.json`, route `GET /api/experimental/session/stats`).
 * The route returns `{ data: SessionStats.Info }`; the client method unwraps
 * `.data` and hands `SessionStatsInfo` to the panel, so everything here is
 * typed against the *inner* object.
 *
 * Kept deliberately local to the stats surface (rather than widening
 * `src/api/types.ts`) because R6 is the only consumer — the contract layer is
 * coordinator-owned and the snapshot is the justification for any addition.
 */

/** `TokenUsage.Info` — the token counters the engine reports per scope. */
export interface StatsTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** `Money.USD` — a plain number of US dollars. */
export type StatsCost = number;

/** `Model.Ref` — the model a usage row belongs to. */
export interface StatsModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/** `SessionStats.ToolTotals`. */
export interface StatsToolTotals {
  calls: number;
  succeeded: number;
  failed: number;
  unfinished: number;
}

/** `SessionStats.ToolUsage` — one row of the detail breakdown. */
export interface StatsToolUsage extends StatsToolTotals {
  name: string;
  durationP50?: number;
}

/**
 * `SessionStats.Tools` — a discriminated union keyed on `mode`. With
 * `tools: "none"` (R6's query) the engine returns `{ mode: "none" }`.
 */
export type StatsTools =
  | { mode: "none" }
  | { mode: "summary"; totals: StatsToolTotals }
  | { mode: "detail"; totals: StatsToolTotals; usage: StatsToolUsage[] };

/** `SessionStats.Activity` — one calendar day's step count. */
export interface StatsActivity {
  date: string; // "YYYY-MM-DD"
  steps: number;
}

/** `SessionStats.ModelUsage`. */
export interface StatsModelUsage {
  model: StatsModelRef;
  steps: number;
  tokens: StatsTokenUsage;
  cost: StatsCost;
}

/** `SessionStats.Info` — the full stats payload. */
export interface SessionStatsInfo {
  range: { from: number; to: number };
  sessions: number;
  subagents: number;
  prompts: number;
  steps: number;
  tokens: StatsTokenUsage;
  cost: StatsCost;
  tools: StatsTools;
  activeDays: number;
  streak: number;
  activity: StatsActivity[];
  models: StatsModelUsage[];
}

// ---------------------------------------------------------------------------
// Token totals
// ---------------------------------------------------------------------------

/**
 * Year-to-date total tokens — the sum of every counter the engine reports.
 *
 * The engine separates `cache.read` / `cache.write` from `input`, but the TUI
 * presents one "total tokens" figure, so the surface sums all five. This is a
 * display total only; the breakdown is available for a finer readout.
 */
export function totalTokens(tokens: StatsTokenUsage | null | undefined): number {
  if (!tokens) return 0;
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  );
}

export interface TokenBreakdownRow {
  label: string;
  value: number;
}

/** The hero figure's supporting rows, in engine field order. */
export function tokenBreakdown(tokens: StatsTokenUsage | null | undefined): TokenBreakdownRow[] {
  if (!tokens) return [];
  return [
    { label: "Input", value: tokens.input ?? 0 },
    { label: "Output", value: tokens.output ?? 0 },
    { label: "Reasoning", value: tokens.reasoning ?? 0 },
    { label: "Cache read", value: tokens.cache?.read ?? 0 },
    { label: "Cache write", value: tokens.cache?.write ?? 0 },
  ];
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** Thousands-grouped integer, e.g. `12,345`. */
export function formatInt(value: number): string {
  return groupDigits(Math.round(value));
}

/** Insert `,` every three digits (locale-independent). */
export function groupDigits(value: number): string {
  const s = String(Math.trunc(Math.abs(value)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Compact count for dense readouts, e.g. `1.2M`, `12.3k`, `987`. */
export function formatCount(value: number): string {
  const n = Math.round(value);
  if (n < 1000) return String(n);
  const units: { limit: number; suffix: string }[] = [
    { limit: 1e9, suffix: "B" },
    { limit: 1e6, suffix: "M" },
    { limit: 1e3, suffix: "k" },
  ];
  for (const { limit, suffix } of units) {
    if (n >= limit) {
      const scaled = n / limit;
      return `${scaled >= 10 || Number.isInteger(scaled) ? Math.round(scaled) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return String(n);
}

/** USD cost with just enough precision to be honest, e.g. `$0.00`, `$12.34`. */
export function formatCost(usd: number | null | undefined): string {
  const n = usd ?? 0;
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** `YYYY-MM-DD` for an epoch-ms timestamp (UTC — matches the engine's dates). */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Human day for footers, e.g. `Jan 1, 2026` (UTC). */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Block digits — the hero token figure
// ---------------------------------------------------------------------------

/**
 * A 3×5 full-block glyph font. Each glyph is an array of five rows, each row
 * exactly three cells of `█` / space. `,` and `.` are the only punctuation the
 * hero figure ever needs (digits are grouped with commas).
 */
const GLYPHS: Record<string, string[]> = {
  "0": ["███", "█ █", "█ █", "█ █", "███"],
  "1": [" █ ", "██ ", " █ ", " █ ", "███"],
  "2": ["███", "  █", "███", "█  ", "███"],
  "3": ["███", "  █", "███", "  █", "███"],
  "4": ["█ █", "█ █", "███", "  █", "  █"],
  "5": ["███", "█  ", "███", "  █", "███"],
  "6": ["███", "█  ", "███", "█ █", "███"],
  "7": ["███", "  █", "  █", "  █", "  █"],
  "8": ["███", "█ █", "███", "█ █", "███"],
  "9": ["███", "█ █", "███", "  █", "███"],
  ",": ["   ", "   ", "   ", " █ ", "█  "],
  ".": ["   ", "   ", "   ", "   ", " █ "],
  " ": ["   ", "   ", "   ", "   ", "   "],
};

const BLANK_GLYPH = ["   ", "   ", "   ", "   ", "   "];

/**
 * Render a number as giant "block digit" glyph rows — the v2 stats hero.
 * Digits are grouped with thousands separators. Returns one string per row
 * (five rows); join with `\n` inside a monospace `<pre>` to display.
 */
export function blockDigits(value: number): string[] {
  const text = groupDigits(Math.round(Math.abs(value)));
  const glyphs = [...text].map((ch) => GLYPHS[ch] ?? BLANK_GLYPH);
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(glyphs.map((g) => g[r]!).join(" "));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Activity calendar (GitHub-style)
// ---------------------------------------------------------------------------

export interface StatsCalendarDay {
  /** `YYYY-MM-DD` (the engine's date key). */
  date: string;
  steps: number;
  /** False for the leading/trailing padding days outside the year. */
  inYear: boolean;
}

export interface StatsCalendarWeek {
  days: StatsCalendarDay[]; // always 7, Sunday → Saturday
}

export interface StatsCalendarMonth {
  label: string; // "Jan" … "Dec"
  /** Column index (0-based) whose week contains the first of the month. */
  weekIndex: number;
}

export interface StatsCalendar {
  year: number;
  /** One entry per column; each holds seven days (Sunday → Saturday). */
  weeks: StatsCalendarWeek[];
  months: StatsCalendarMonth[];
  /** Highest in-year day step count — the intensity scale's top. */
  maxSteps: number;
  /** In-year steps summed. */
  totalSteps: number;
  /** In-year days with at least one step. */
  activeDays: number;
}

const DAY_MS = 86_400_000;
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Build the year's GitHub-style activity grid: columns are weeks (Sunday
 * first), rows are weekdays. The grid is padded to whole weeks on both ends,
 * so it spans the year plus up to six leading/trailing days.
 *
 * `activity` may contain dates outside `year` (the engine returns the queried
 * range); out-of-year dates are ignored for totals and never marked `inYear`.
 */
export function buildCalendar(
  activity: StatsActivity[] | null | undefined,
  year: number,
): StatsCalendar {
  const byDate = new Map<string, number>();
  for (const entry of activity ?? []) {
    if (entry && typeof entry.date === "string") byDate.set(entry.date, entry.steps ?? 0);
  }

  const jan1 = Date.UTC(year, 0, 1);
  const dec31 = Date.UTC(year, 11, 31);
  const gridStart = jan1 - new Date(jan1).getUTCDay() * DAY_MS;
  const gridEnd = dec31 + (6 - new Date(dec31).getUTCDay()) * DAY_MS;

  const weeks: StatsCalendarWeek[] = [];
  for (let cursor = gridStart; cursor <= gridEnd; cursor += 7 * DAY_MS) {
    const days: StatsCalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const ms = cursor + i * DAY_MS;
      const date = isoDay(ms);
      const inYear = ms >= jan1 && ms <= dec31;
      days.push({ date, steps: inYear ? (byDate.get(date) ?? 0) : 0, inYear });
    }
    weeks.push({ days });
  }

  const months: StatsCalendarMonth[] = MONTH_LABELS.map((label, m) => ({
    label,
    weekIndex: Math.round((Date.UTC(year, m, 1) - gridStart) / (7 * DAY_MS)),
  }));

  const startStr = isoDay(jan1);
  const endStr = isoDay(dec31);
  let totalSteps = 0;
  let activeDays = 0;
  let maxSteps = 0;
  for (const [date, steps] of byDate) {
    if (date < startStr || date > endStr) continue;
    totalSteps += steps;
    if (steps > 0) activeDays++;
    if (steps > maxSteps) maxSteps = steps;
  }

  return { year, weeks, months, maxSteps, totalSteps, activeDays };
}

/**
 * Map a day's step count onto the five-level intensity scale the calendar
 * paints (0 = empty). Quartile bands relative to the year's busiest day.
 */
export function intensityLevel(steps: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (steps <= 0) return 0;
  if (max <= 0) return 1;
  const ratio = steps / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}
