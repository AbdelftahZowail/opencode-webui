import { useMemo } from "react";
import { cn } from "../lib/utils";

/**
 * The ONE diff renderer. Everything diff-shaped in the app renders through
 * this file: tool-card edit results, the file explorer's per-file diff, and
 * the turn-scoped DiffViewer (P2). Layouts are a prop (`view`), not a second
 * renderer — `parseDiff` is the single parser.
 */

export interface DiffLine {
  text: string;
  kind: "file" | "hunk" | "add" | "delete" | "context";
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(diff: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const text of diff.split("\n")) {
    // SVN-style patch headers (service edit-tool output) are chrome, not content.
    if (text.startsWith("Index: ") || text.startsWith("=======") || text.startsWith("diff --git ")) {
      continue;
    }
    if (text.startsWith("+++ ") || text.startsWith("--- ")) {
      rows.push({ text, kind: "file" });
      continue;
    }
    if (text.startsWith("@@")) {
      const match = HUNK_RE.exec(text);
      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[3]) : 0;
      rows.push({ text, kind: "hunk" });
      continue;
    }
    if (text.startsWith("+")) {
      rows.push({ text, kind: "add", newNo });
      newNo += 1;
    } else if (text.startsWith("-")) {
      rows.push({ text, kind: "delete", oldNo });
      oldNo += 1;
    } else {
      rows.push({
        text,
        kind: "context",
        oldNo: oldNo > 0 ? oldNo : undefined,
        newNo: newNo > 0 ? newNo : undefined,
      });
      if (oldNo > 0) oldNo += 1;
      if (newNo > 0) newNo += 1;
    }
  }
  return rows;
}

export function groupHunks(rows: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  for (const row of rows) {
    if (row.kind === "hunk") {
      const match = HUNK_RE.exec(row.text);
      current = {
        header: row.text,
        oldStart: match ? Number(match[1]) : 0,
        newStart: match ? Number(match[3]) : 0,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (row.kind === "file") {
      current = undefined;
      continue;
    }
    if (current) current.lines.push(row);
  }
  return hunks;
}

const ROW_CLASSES: Record<DiffLine["kind"], string> = {
  file: "bg-(--surface-diff-unchanged-base) text-(color:--text-strong)",
  hunk: "bg-(--surface-diff-hidden-base) text-(color:--text-weak)",
  add: "bg-(--surface-diff-add-weak) text-(color:--text-diff-add-base)",
  delete: "bg-(--surface-diff-delete-weak) text-(color:--text-diff-delete-base)",
  context: "bg-(--surface-diff-unchanged-base) text-(color:--text-base)",
};

/** One side of a side-by-side row. `null` = the other side has no counterpart. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Align parsed rows into side-by-side pairs: a run of deletes/adds is zipped
 * index-wise (the standard two-column alignment), everything else mirrors.
 * Pure — exported so the DiffViewer can reuse the same alignment for hunk
 * navigation without re-parsing.
 */
export function toSplitRows(rows: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.kind === "add" || row.kind === "delete") {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < rows.length && (rows[i]!.kind === "add" || rows[i]!.kind === "delete")) {
        const r = rows[i]!;
        if (r.kind === "add") adds.push(r);
        else dels.push(r);
        i += 1;
      }
      const count = Math.max(dels.length, adds.length);
      for (let k = 0; k < count; k += 1) {
        out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      }
      continue;
    }
    out.push({ left: row, right: row });
    i += 1;
  }
  return out;
}

/** The hunk ordinal of each row, or -1 for non-hunk rows (navigation aid). */
export function hunkOrdinals(rows: DiffLine[]): number[] {
  let n = 0;
  return rows.map((row) => (row.kind === "hunk" ? n++ : -1));
}

export function DiffView({
  diff,
  className,
  view = "unified",
  activeHunk,
}: {
  diff: string;
  className?: string;
  view?: "unified" | "split";
  /** Marks this hunk (0-based) so the viewer can scroll it into place. */
  activeHunk?: number;
}) {
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const splits = useMemo(() => (view === "split" ? toSplitRows(rows) : []), [rows, view]);
  const ordinals = useMemo(() => hunkOrdinals(rows), [rows]);
  const splitOrdinals = useMemo(() => {
    let n = 0;
    return splits.map((row) => (row.left?.kind === "hunk" ? n++ : -1));
  }, [splits]);

  return (
    <div className={cn("overflow-x-auto font-mono text-xs", className)}>
      <div className="min-w-max">
        {view === "split"
          ? splits.map((row, index) => (
              <SplitDiffRow
                key={index}
                row={row}
                activeHunk={activeHunk}
                ordinal={splitOrdinals[index]}
              />
            ))
          : rows.map((row, index) => (
              <DiffRow
                key={index}
                row={row}
                activeHunk={activeHunk}
                ordinal={ordinals[index]}
              />
            ))}
      </div>
    </div>
  );
}

function DiffRow({
  row,
  activeHunk,
  ordinal,
}: {
  row: DiffLine;
  activeHunk?: number;
  ordinal?: number;
}) {
  const showGutter = row.kind === "add" || row.kind === "delete" || row.kind === "context";
  const isActive = row.kind === "hunk" && ordinal === activeHunk;
  return (
    <div
      data-diff-hunk={isActive ? ordinal : undefined}
      data-diff-kind={row.kind}
      className={cn("flex items-center whitespace-pre", ROW_CLASSES[row.kind], isActive && "ring-1 ring-inset ring-[var(--border-selected)]")}
    >
      {showGutter && (
        <span className="shrink-0 select-none pl-2 pr-1 text-right text-(color:--text-weaker)">
          <span className="inline-block w-9">{row.oldNo ?? ""}</span>
          <span className="inline-block w-9">{row.newNo ?? ""}</span>
        </span>
      )}
      <span className={cn("min-w-0", showGutter && "pr-2")}>{row.text || " "}</span>
    </div>
  );
}

function SplitDiffRow({
  row,
  activeHunk,
  ordinal,
}: {
  row: SplitRow;
  activeHunk?: number;
  ordinal?: number;
}) {
  const line = row.left;
  // File/hunk chrome spans both columns (it describes the whole hunk).
  if (line && (line.kind === "file" || line.kind === "hunk")) {
    const isActive = line.kind === "hunk" && ordinal === activeHunk;
    return (
      <div
        data-diff-hunk={isActive ? ordinal : undefined}
        data-diff-kind={line.kind}
        className={cn(
          "flex whitespace-pre",
          ROW_CLASSES[line.kind],
          isActive && "ring-1 ring-inset ring-[var(--border-selected)]",
        )}
      >
        <span className="min-w-0 pr-2 pl-2">{line.text || " "}</span>
      </div>
    );
  }
  return (
    <div className="flex">
      <SplitCell line={row.left} side="left" />
      <SplitCell line={row.right} side="right" />
    </div>
  );
}

function SplitCell({ line, side }: { line: DiffLine | null; side: "left" | "right" }) {
  const kind = line?.kind ?? "context";
  const no = side === "left" ? line?.oldNo : line?.newNo;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center whitespace-pre border-r border-[var(--border-weak-base)]",
        line ? ROW_CLASSES[kind] : "bg-(--surface-diff-hidden-base)",
      )}
    >
      <span className="shrink-0 select-none pl-2 pr-1 text-right text-(color:--text-weaker)">
        <span className="inline-block w-9">{no ?? ""}</span>
      </span>
      <span className="min-w-0 flex-1 pr-2">{line?.text || " "}</span>
    </div>
  );
}
