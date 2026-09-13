/**
 * Extension lifecycle — the activation context (roadmap item 7).
 *
 * A browser-stratum folder may expose an activation entry instead of
 * registering at module scope:
 *
 *   export const id = "my-extension";
 *   export function activate(ctx) {
 *     ctx.register({ kind: "wrap", id: "my-wrap", target: "…", render: … });
 *     const stop = someWatcher();
 *     ctx.onDispose(stop);          // or: return stop
 *   }
 *
 * `activate` is called ONCE per load, with a context scoped to the
 * extension:
 *   - `ctx.register(entry)` registers a v2 entry into the one registry and
 *     remembers the id, so teardown prunes exactly this extension's entries.
 *   - `ctx.onDispose(fn)` (and a returned teardown fn) run on hot-swap,
 *     disable, and delete — the place non-React cleanup hooks live, with no
 *     `window.__*Installed` guards.
 *   - `ctx.log(...)` prefixes the app log with the extension id.
 *   - `ctx.services` exposes the existing named-logic service lookups.
 *
 * The ambient module-scope shape still works (the loaders fall back to the
 * registry id-delta) but is the shape being deprecated: activation is the
 * contract, and later roadmap items widen the context (scheduler, events,
 * store, settings) so an extension never owns a raw timer or a global.
 *
 * One lifecycle, one context — this module owns both, and the two loaders
 * (`src/lib/runtimeExtensions.ts`, `webui-extensions/index.ts`) call
 * `activateExtension` so shipped and external bundles behave identically.
 */

import { register, unregisterIds, getService, getServiceProviders, type ExtInput } from "./registry";
import { registerPoller, type Tier } from "../lib/scheduler";

/** Teardown returned by an activation entry: a function, or nothing. */
export type ActivateResult = void | (() => void) | Promise<void | (() => void)>;

/**
 * A recurring registration for the shared scheduler (the app's only timer
 * owner). `name` is namespaced with the extension id for debug logs; cadence
 * is tier-aware exactly like core pollers (LIVE ~2s / IDLE ~12s / HIDDEN ~60s
 * by default, `minInterval` is the floor). Disposed with the extension.
 */
export interface ExtensionPollOptions {
  /** Short name for debug logs (namespaced `ext:<id>:<name>`). */
  name: string;
  /** Floor across all tiers — a tier override can stretch but never go below. */
  minInterval: number;
  /** Per-tier cadence overrides; missing tiers fall back to `minInterval`. */
  intervals?: Partial<Record<Tier, number>>;
  /** Run while the tab is hidden (default false — most polls can wait). */
  whenHidden?: boolean;
  /** The work. May be async; rejections are caught and logged by the scheduler. */
  run: () => unknown;
}

/** The context object every activation entry receives. */
export interface ExtensionContext {
  /** The extension's manifest id. */
  readonly id: string;
  /**
   * Register a v2 entry. Same-id re-registration still swaps in place; the
   * id is remembered so disposal prunes exactly what this extension added.
   */
  register(entry: ExtInput): void;
  /**
   * Recurring work on the shared scheduler (tier-aware, jittered, no
   * component-owned `setInterval`). Returns an idempotent unregister; the
   * poller is also stopped automatically on dispose.
   */
  poll(opts: ExtensionPollOptions): () => void;
  /**
   * One-shot delay. Returns an idempotent cancel; the timer is also cleared
   * automatically on dispose. (One-shots are the documented exception to
   * "the scheduler owns recurring timers".)
   */
  after(ms: number, fn: () => void): () => void;
  /** Run `fn` on dispose (hot-swap, disable, delete). LIFO; crash-isolated. */
  onDispose(fn: () => void): void;
  /** Extension-scoped log line (prefixed with the id). */
  log(message: string, ...args: unknown[]): void;
  /** Named-logic service lookups (same as the bridge's `services`). */
  services: {
    getService: typeof getService;
    getServiceProviders: typeof getServiceProviders;
  };
}

export type ActivateFn = (ctx: ExtensionContext) => ActivateResult;

/**
 * The result of running a module's activation entry. For an ambient module
 * (no `activate`/default fn) `activated` is false and disposal is a no-op —
 * the loader keeps its registry id-delta behavior for that shape.
 */
export interface ExtensionInstance {
  readonly id: string;
  /** True when the module exposed an activation entry. */
  readonly activated: boolean;
  /** Registry ids the context owns (empty for ambient modules). */
  readonly ownedIds: readonly string[];
  /** Run teardown + unregister owned ids. Idempotent, crash-isolated. */
  dispose(): void;
}

const NOOP_INSTANCE = (id: string): ExtensionInstance => ({
  id,
  activated: false,
  ownedIds: [],
  dispose() {},
});

/** The activation fn a module exposes, if any (`activate`, else default). */
export function pickActivate(mod: unknown): ActivateFn | undefined {
  if (!mod || typeof mod !== "object") return undefined;
  const m = mod as { activate?: unknown; default?: unknown };
  if (typeof m.activate === "function") return m.activate as ActivateFn;
  if (typeof m.default === "function") return m.default as ActivateFn;
  return undefined;
}

function makeContext(id: string): {
  ctx: ExtensionContext;
  ownedIds: Set<string>;
  dispose: () => void;
} {
  const ownedIds = new Set<string>();
  const disposers: (() => void)[] = [];
  let disposed = false;

  const ctx: ExtensionContext = {
    id,
    register(entry) {
      register(entry);
      ownedIds.add(entry.id);
    },
    poll(opts) {
      const stop = registerPoller({ ...opts, name: `ext:${id}:${opts.name}` });
      disposers.push(stop);
      return stop;
    },
    after(ms, fn) {
      let handle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        handle = null;
        try {
          fn();
        } catch (err) {
          console.error(`[extensions] "${id}" after(${ms}) fn failed:`, err);
        }
      }, ms);
      const cancel = () => {
        if (handle !== null) {
          clearTimeout(handle);
          handle = null;
        }
      };
      disposers.push(cancel);
      return cancel;
    },
    onDispose(fn) {
      disposers.push(fn);
    },
    log(message, ...args) {
      console.log(`[ext:${id}] ${message}`, ...args);
    },
    services: { getService, getServiceProviders },
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // LIFO teardown, each isolated: a throwing cleanup must not strand the
    // rest (same crash-isolation rule as hooks/targets).
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        disposers[i]!();
      } catch (err) {
        console.error(`[extensions] "${id}" dispose fn failed:`, err);
      }
    }
    disposers.length = 0;
    if (ownedIds.size > 0) unregisterIds([...ownedIds]);
    ownedIds.clear();
  };

  return { ctx, ownedIds, dispose };
}

/**
 * Run a module's activation entry (if present) against a fresh, disposable
 * context. A module with no entry yields an inert instance (the loaders then
 * use their legacy id-delta path). Activation errors are logged and never
 * thrown — one broken extension must not break the loader.
 */
export async function activateExtension(
  id: string,
  mod: unknown,
): Promise<ExtensionInstance> {
  const activate = pickActivate(mod);
  if (!activate) return NOOP_INSTANCE(id);

  const { ctx, ownedIds, dispose } = makeContext(id);
  try {
    const result = activate(ctx);
    const teardown = result instanceof Promise ? await result : result;
    if (typeof teardown === "function") ctx.onDispose(teardown as () => void);
  } catch (err) {
    console.error(`[extensions] "${id}" activate failed:`, err);
  }
  return {
    id,
    activated: true,
    ownedIds: [...ownedIds],
    dispose,
  };
}
