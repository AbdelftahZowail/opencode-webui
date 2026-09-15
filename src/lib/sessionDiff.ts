/**
 * Pure helpers for the turn-scoped diff viewer (P2): the changed-file tree,
 * totals, status presentation and hunk counting. No React, no store, no api
 * calls — so it is unit-testable and `DiffViewer.tsx` stays components-only.
 *
 * Parsing itself lives in ONE place (`components/DiffView.tsx`); this module
 * only shapes file-level data around it.
 */

import { groupHunks, parseDiff } from "../components/DiffView";
import type { FileDiffInfo } from "../api/client";

/**
 * The three sources the viewer can show, matching v2's diff plugin:
 *  - "turn"    — the newest idle-to-idle turn (steered prompts fold into it)
 *  - "working" — HEAD vs the working copy
 *  - "branch"  — the inferred base merge-base vs the working copy
 * The type lives here (a pure module) so the store and the viewer share ONE
 * definition without the lib importing the store.
 */
export type DiffSource = "working" | "branch" | "turn";

export const DIFF_SOURCES: readonly DiffSource[] = ["turn", "working", "branch"];

/** Unchanged lines kept around each hunk when asking the engine for a diff. */
export const VCS_DIFF_CONTEXT_LINES = 12;

export function diffSourceLabel(source: DiffSource): string {
  if (source === "turn") return "Last turn";
  if (source === "branch") return "Branch base";
  return "Working tree";
}

export function diffSourceHint(source: DiffSource): string {
  if (source === "turn") {
    return "What the most recent turn changed — a turn runs idle marker to idle marker, so prompts steered in while it was busy belong to it";
  }
  if (source === "branch") return "The base merge-base compared with the working copy";
  return "HEAD compared with the working copy";
}

export type DiffStatus = FileDiffInfo["status"];

/** Single-letter status marker (A/D/M), the v2 file-tree idiom. */
export function statusLabel(status: DiffStatus): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

export function statusClass(status: DiffStatus): string {
  if (status === "added") return "text-[color:var(--surface-success-strong)]";
  if (status === "deleted") return "text-[color:var(--surface-critical-strong)]";
  return "text-[color:var(--surface-warning-strong)]";
}

export interface DiffTreeNode {
  /** Display name — the last path segment. */
  name: string;
  /** Full file path for files; the directory path for directories. */
  path: string;
  type: "dir" | "file";
  depth: number;
  /** Set on file nodes only. */
  file?: FileDiffInfo;
  children: DiffTreeNode[];
}

/**
 * Build the changed-file tree. Directories sort before files, each
 * alphabetically, so the tree is stable across refreshes.
 */
export function buildDiffTree(files: FileDiffInfo[]): DiffTreeNode[] {
  interface Builder {
    dirs: Map<string, Builder>;
    files: DiffTreeNode[];
  }
  const root: Builder = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.file.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i]!;
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push({
      name: parts[parts.length - 1]!,
      path: file.file,
      type: "file",
      depth: 0,
      file,
      children: [],
    });
  }
  const toNodes = (builder: Builder, depth: number, prefix: string): DiffTreeNode[] => {
    const dirs = [...builder.dirs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, child]) => {
        const path = prefix ? `${prefix}/${name}` : name;
        return {
          name,
          path,
          type: "dir" as const,
          depth,
          children: toNodes(child, depth + 1, path),
        };
      });
    const leaves = builder.files
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ ...f, depth }));
    return [...dirs, ...leaves];
  };
  return toNodes(root, 0, "");
}

/** Depth-first rows for the tree, skipping the children of collapsed dirs. */
export function flattenDiffTree(
  nodes: DiffTreeNode[],
  collapsed: ReadonlySet<string>,
): DiffTreeNode[] {
  const out: DiffTreeNode[] = [];
  const walk = (list: DiffTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.type === "dir" && !collapsed.has(node.path)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Every directory path in the tree (for expand-all / collapse-all). */
export function diffTreeDirs(nodes: DiffTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: DiffTreeNode[]) => {
    for (const node of list) {
      if (node.type !== "dir") continue;
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function diffTotals(files: FileDiffInfo[]): {
  files: number;
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { files: files.length, additions, deletions };
}

/** Number of hunks in a patch — the cursor space for hunk navigation. */
export function hunkCount(patch: string | undefined): number {
  if (!patch) return 0;
  return groupHunks(parseDiff(patch)).length;
}
