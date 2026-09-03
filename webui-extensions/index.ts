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
 * Deletion pruning is owned-set only: this loader unregisters ids IT loaded
 * that are now missing — never the runtime loader's ids (those belong to
 * src/lib/runtimeExtensions.ts). The previous seen-set survives HMR re-runs
 * via `import.meta.hot.data`.
 */

import { unregisterIds } from "../src/extensions/registry";

const loaders = import.meta.glob("./*/index.{ts,tsx}");

type HotData = { prevSeen?: string[] };

async function discover() {
  const seen = new Set<string>();
  await Promise.all(
    Object.values(loaders).map(async (load) => {
      const mod = (await load()) as { id?: unknown } | undefined;
      if (mod && typeof mod.id === "string") seen.add(mod.id);
    }),
  );
  const prev = new Set<string>(
    (import.meta.hot?.data as HotData | undefined)?.prevSeen ?? [],
  );
  const gone = [...prev].filter((id) => !seen.has(id));
  if (gone.length > 0) unregisterIds(gone);
  if (import.meta.hot) {
    (import.meta.hot.data as HotData).prevSeen = [...seen];
  }
}

void discover();

if (import.meta.hot) import.meta.hot.accept();
