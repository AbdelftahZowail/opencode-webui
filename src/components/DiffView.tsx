import { useMemo } from "react";
import { cn } from "../lib/utils";

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

export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const rows = useMemo(() => parseDiff(diff), [diff]);

  return (
    <div className={cn("overflow-x-auto font-mono text-xs", className)}>
      <div className="min-w-max">
        {rows.map((row, index) => (
          <DiffRow key={index} row={row} />
        ))}
      </div>
    </div>
  );
}

function DiffRow({ row }: { row: DiffLine }) {
  const showGutter = row.kind === "add" || row.kind === "delete" || row.kind === "context";
  return (
    <div className={cn("flex items-center whitespace-pre", ROW_CLASSES[row.kind])}>
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
