/**
 * Shipped-extension entry point — discovers every
 * webui-extensions/<name>/index.{ts,tsx}.
 *
 * Gating (spec §4) is owned by the folder itself: presence = installed.
 * Installing = drop the folder in here; removing = delete the folder.
 *
 * Lifecycle (roadmap 7): a folder may export `activate(ctx)` (or a default
 * fn) and receive a disposable context — `ctx.register` remembers ids,
 * `ctx.onDispose`/a returned teardown runs on hot-swap/delete. This loader
 * calls the shared `activateExtension`, so shipped and external folders obey
 * the exact same contract (only the transport differs), and it disposes the
 * previous instance before activating a replaced module (HMR) or dropping a
 * removed one. Ambient module-scope registration still works: the loader
 * snapshots the registry around each import and records the owned id delta,
 * so disable/delete unregisters exactly what the folder added (a multi-id
 * folder leaves no ghosts) and never touches the runtime loader's ids.
 *
 * The applied-instance map (module identity → instance) survives HMR re-runs
 * via `import.meta.hot.data`; an unchanged module object is skipped, a new
 * one is torn down + re-activated.
 */

import { getRegisteredIds, unregisterIds } from "../src/extensions/registry";
import { activateExtension, type ExtensionInstance } from "../src/extensions/context";
import { parseManifestContract } from "../src/extensions/manifest";
import { registerExtensionSchema } from "../src/lib/extSettings";

const loaders = import.meta.glob("./*/index.{ts,tsx}");

/**
 * Each shipped folder's `manifest.json`, read eagerly so an activate entry's
 * `ctx.settings` is schema-aware BEFORE it runs (the runtime loader also
 * registers schemas, but it syncs from the proxy after boot). `requires` for
 * shipped ids is validated by the runtime loader, which sees the manifest.
 */
const manifests = import.meta.glob("./*/manifest.json", { eager: true }) as Record<
  string,
  { default?: unknown }
>;
const contractByID = new Map<string, ReturnType<typeof parseManifestContract>>();
for (const mod of Object.values(manifests)) {
  const raw = mod?.default;
  if (!raw || typeof raw !== "object") continue;
  const rec = raw as { id?: unknown; settings?: unknown; requires?: unknown };
  if (typeof rec.id !== "string" || rec.id.length === 0) continue;
  contractByID.set(rec.id, parseManifestContract(rec.settings, rec.requires));
}

interface Applied {
  /** The module object as imported last time — identity detects a swap. */
  mod: object;
  /** Registry ids this folder owns (activation context + import delta). */
  owned: Set<string>;
  instance: ExtensionInstance;
}
type HotData = { prevSeen?: string[]; applied?: Record<string, Applied> };

async function discover(): Promise<void> {
  const hot = import.meta.hot?.data as HotData | undefined;
  const applied = new Map<string, Applied>(Object.entries(hot?.applied ?? {}));
  const seen = new Set<string>();
  // Sequential (not Promise.all): each snapshot pair must attribute its
  // delta to exactly one folder's import.
  for (const load of Object.values(loaders)) {
    let mod: (object & { id?: unknown }) | undefined;
    try {
      mod = (await (load as () => Promise<unknown>)()) as object & { id?: unknown };
    } catch {
      continue;
    }
    if (!mod || typeof mod.id !== "string") continue;
    const id = mod.id;
    seen.add(id);

    const prev = applied.get(id);
    if (prev && prev.mod === mod) continue; // unchanged since the last run

    // Settings schema (roadmap 5): register before activate so ctx.settings
    // resolves defaults even at first activation.
    registerExtensionSchema(id, contractByID.get(id)?.settings);

    // Changed (or first load): tear the previous instance down BEFORE the new
    // one activates, so old ids can't collide with the new set.
    if (prev) {
      applied.delete(id);
      prev.instance.dispose();
      unregisterIds([...prev.owned]);
    }
    const before = new Set(getRegisteredIds());
    const instance = await activateExtension(id, mod);
    const after = getRegisteredIds();
    const owned = new Set<string>();
    for (const rid of after) {
      if (!before.has(rid)) owned.add(rid);
    }
    applied.set(id, { mod, owned, instance });
  }

  const prevSeen = new Set<string>(hot?.prevSeen ?? []);
  const gone = [...prevSeen].filter((id) => !seen.has(id));
  if (gone.length > 0) {
    const toRemove = new Set<string>();
    for (const id of gone) {
      const rec = applied.get(id);
      if (rec) {
        rec.instance.dispose();
        if (rec.owned.size > 0) {
          for (const rid of rec.owned) toRemove.add(rid);
        } else {
          toRemove.add(id);
        }
        applied.delete(id);
      } else {
        toRemove.add(id);
      }
    }
    if (toRemove.size > 0) unregisterIds([...toRemove]);
  }

  if (import.meta.hot) {
    (import.meta.hot.data as HotData).prevSeen = [...seen];
    (import.meta.hot.data as HotData).applied = Object.fromEntries(applied);
  }
}

/** Serialize discovery; a re-run requested mid-flight queues one more pass. */
let running = false;
let dirty = false;
async function pump(): Promise<void> {
  if (running) {
    dirty = true;
    return;
  }
  running = true;
  do {
    dirty = false;
    await discover().catch(() => undefined);
  } while (dirty);
  running = false;
}

void pump();

if (import.meta.hot) {
  import.meta.hot.accept();
  // A child extension edit may bubble here rather than re-evaluate this
  // module; re-run discovery so activate-based shipped extensions hot-swap
  // (unchanged modules are skipped by identity, so this is cheap + idempotent).
  import.meta.hot.on("vite:afterUpdate", () => void pump());
}
