/**
 * Workspace/directory presentation helpers shared by the sidebar session
 * list and the search panel. Kept in a lib module (not exported from a
 * component file) so React Fast Refresh stays enabled for the components.
 */

export function isHomeDir(dir: string): boolean {
  return /^\/home\/[^/]+$/.test(dir) || /^\/Users\/[^/]+$/.test(dir);
}

/** The most frequently seen home-dir candidate, used to shorten `~/...`. */
export function findHome(dirs: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const d of dirs) {
    if (!d) continue;
    const t = d.replace(/\/+$/, "");
    if (isHomeDir(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [dir, n] of counts) {
    if (n > bestN) {
      best = dir;
      bestN = n;
    }
  }
  return best;
}

/** Display name for a workspace directory ("~", "~/code", or the raw path). */
export function workspaceName(directory: string | undefined, home?: string): string {
  if (!directory) return "Other";
  const trimmed = directory.replace(/\/+$/, "");
  if (home && isHomeDir(home) && trimmed === home) return "~";
  if (home && isHomeDir(home) && trimmed.startsWith(home + "/")) {
    return "~/" + trimmed.slice(home.length + 1);
  }
  return trimmed;
}

/** Directory equality that tolerates trailing slashes. */
export function sameDirectory(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
