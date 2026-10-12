/**
 * Pure helpers for the diff viewer's base-branch picker (parity R7).
 *
 * v2's viewer lists local + remote branches from `client.vcs.branches(...)`
 * and lets you pick one as the diff base (`diff-viewer.tsx:219-234`). We build
 * that list from `api.vcsBranches` (a bare `string[]`), so the filtering and
 * grouping live here — no React, no store — and `DiffViewer.tsx` stays
 * components-only.
 */

export interface BranchGroups {
  /** Refs without a slash (`main`, `feature/x` is remote-ish… see below). */
  local: string[];
  /** Remote-tracking refs (`origin/main`, `upstream/x`). */
  remote: string[];
}

/**
 * A remote-tracking ref carries a slash (`origin/main`). This is the same
 * heuristic the TUI applies to the flat name list — it is a display grouping
 * only, never a correctness decision.
 */
export function isRemoteBranch(name: string): boolean {
  return name.includes("/");
}

/** Trim, drop empties, and de-dupe while preserving input order. */
export function normalizeBranches(branches: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of branches) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Case-insensitive substring filter over the branch names. An empty/blank
 * query returns the whole (normalized) list, so the picker always opens with
 * the full set.
 */
export function filterBranches(branches: readonly string[], query: string): string[] {
  const all = normalizeBranches(branches);
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((branch) => branch.toLowerCase().includes(q));
}

/** Split the list into the picker's local / remote sections. */
export function groupBranches(branches: readonly string[]): BranchGroups {
  const local: string[] = [];
  const remote: string[] = [];
  for (const name of normalizeBranches(branches)) {
    (isRemoteBranch(name) ? remote : local).push(name);
  }
  return { local, remote };
}

/**
 * Header label for the chosen base: the ref when one is chosen, else `auto`
 * (the engine's inferred merge-base). v2 renders `vs <base>`.
 */
export function baseLabel(base: string | null | undefined): string {
  const trimmed = base?.trim();
  return trimmed ? trimmed : "auto";
}
