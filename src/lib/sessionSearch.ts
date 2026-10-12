/**
 * R11a — pure helpers for the session-list dialog's project scoping.
 *
 * The engine's `GET /api/session?search=` is GLOBAL: it takes no project or
 * directory scope (verified against the contract — `api.listSessions` sends
 * only `limit`/`cursor`/`order`/`search`). v2's session list has a `ctrl+a`
 * "all projects" toggle, so "this project" must be a CLIENT-SIDE filter over
 * the returned sessions: match the focused session's directory subtree. Kept
 * pure and here (not in the component or the store) so it is testable headless
 * and every caller shares one definition.
 */

import type { SessionInfo } from "../api/types";

/** Normalize a directory: drop a single trailing slash (but keep a bare "/"). */
function norm(directory: string): string {
  return directory.length > 1 && directory.endsWith("/") ? directory.slice(0, -1) : directory;
}

/** True when `directory` is `root` itself or a descendant of it. */
export function withinDirectory(
  directory: string | null | undefined,
  root: string | null | undefined,
): boolean {
  if (!root) return true; // no scope -> everything is in scope
  if (!directory) return false;
  const d = norm(directory);
  const r = norm(root);
  if (r === "/") return d.startsWith("/");
  return d === r || d.startsWith(`${r}/`);
}

/**
 * Scope a session list to one project directory subtree. `keep` ids (the
 * pinned sessions) are always retained so R11's quick-slot column stays
 * complete even when a pin points at another project — the pins rail stays in
 * the Sidebar and this dialog only mirrors it, never owns a second pin store.
 */
export function filterSessionsToProject(
  sessions: SessionInfo[],
  root: string | null | undefined,
  keep: Iterable<string> = [],
): SessionInfo[] {
  if (!root) return sessions;
  const keepSet = new Set(keep);
  const out = sessions.filter(
    (s) => keepSet.has(s.id) || withinDirectory(s.location?.directory, root),
  );
  return out.length === sessions.length ? sessions : out;
}
