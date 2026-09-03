/**
 * Shipped-extension entry point — discovers every
 * webui-extensions/<name>/index.{ts,tsx}.
 *
 * Gating (spec §4) is owned by the folder itself: presence = installed.
 * Installing = drop the folder in here; removing = delete the folder. Both
 * re-run this module through HMR with a fresh loader set — no page reload.
 * Each entry must `export const id` and self-accept so its own EDITS
 * hot-swap live (same-id registry swap).
 *
 * Deletion pruning is owned-delta only: this loader snapshots the registry
 * around each bundle import and records the id delta per folder, so
 * disable/delete unregisters exactly what the folder added (a multi-id
 * folder leaves no ghosts). It never touches the runtime loader's ids
 * (those belong to src/lib/runtimeExtensions.ts). The previous seen-set +
 * owned-delta map survive HMR re-runs via `import.meta.hot.data`.
 *
 * One-id-per-folder stays as guidance (simpler to reason about) but the
 * loader no longer depends on it (IN-3, G-F2/F4 remainder — IMPLEMENTED).
 */

import { getRegisteredIds, unregisterIds } from "../src/extensions/registry";

const loaders = import.meta.glob("./*/index.{ts,tsx}");

type HotData = { prevSeen?: string[]; prevOwned?: Record<string, string[]> };

async function discover() {
  const hot = import.meta.hot?.data as HotData | undefined;
  const owned = new Map<string, Set<string>>(
    Object.entries(hot?.prevOwned ?? {}).map(([k, v]) => [k, new Set(v)]),
  );
  const seen = new Set<string>();
  // Sequential (not Promise.all): each snapshot pair must attribute its
  // delta to exactly one folder's import.
  for (const load of Object.values(loaders)) {
    const before = new Set(getRegisteredIds());
    let mod: { id?: unknown } | undefined;
    try {
      mod = (await (load as () => Promise<unknown>)()) as { id?: unknown } | undefined;
    } catch {
      continue;
    }
    if (!mod || typeof mod.id !== "string") continue;
    seen.add(mod.id);
    const after = getRegisteredIds();
    let set = owned.get(mod.id);
    if (!set) {
      set = new Set<string>();
      owned.set(mod.id, set);
    }
    for (const rid of after) {
      if (!before.has(rid)) set.add(rid);
    }
  }
  const prev = new Set<string>(hot?.prevSeen ?? []);
  const gone = [...prev].filter((id) => !seen.has(id));
  if (gone.length > 0) {
    const toRemove = new Set<string>();
    for (const id of gone) {
      const set = owned.get(id);
      if (set && set.size > 0) {
        for (const rid of set) toRemove.add(rid);
      } else {
        toRemove.add(id);
      }
      owned.delete(id);
    }
    unregisterIds([...toRemove]);
  }
  if (import.meta.hot) {
    (import.meta.hot.data as HotData).prevSeen = [...seen];
    (import.meta.hot.data as HotData).prevOwned = Object.fromEntries(
      [...owned].map(([k, v]) => [k, [...v]]),
    );
  }
}

void discover();

if (import.meta.hot) import.meta.hot.accept();
