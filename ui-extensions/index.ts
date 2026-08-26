/**
 * Extension entry point — discovers every ui-extensions/<name>/index.{ts,tsx}.
 *
 * Installing an extension = drop the folder in here (visibility gated per-id
 * by `enabled` in config.ts); removing = delete the folder. Both re-run this
 * module through HMR with a fresh loader set — no page reload. Each entry
 * must `export const id` (harvested for pruning) and self-accept so its own
 * EDITS hot-swap live (same-id registry swap).
 */

import { pruneExtensions } from "../src/extensions/registry";

const loaders = import.meta.glob("./*/index.{ts,tsx}");

async function discover() {
  const seen = new Set<string>();
  await Promise.all(
    Object.values(loaders).map(async (load) => {
      const mod = (await load()) as { id?: unknown } | undefined;
      if (mod && typeof mod.id === "string") seen.add(mod.id);
    }),
  );
  pruneExtensions(seen);
}

void discover();

if (import.meta.hot) import.meta.hot.accept();
