import { type ReactNode, Component, useSyncExternalStore } from "react";
import type { MessageInfo, ToolPart } from "../api/types";

/**
 * Extension registry v2 — the stable contract between the app and extensions.
 * See docs/extension-system-spec.md §5.
 *
 * Five kinds, one job each:
 *  - "wrap"       — flow-through tweak of any registered unit. Receives
 *                     props + a `next()` thunk, delegates to live core by
 *                     default. THE DEFAULT PATH FOR EDITS: core updates
 *                     always render *through* it, so wraps are stale-proof
 *                     by construction.
 *  - "replace"    — take ownership of one registered target. Wins outright
 *                     at its priority (frozen-snapshot semantics: the owner
 *                     opts out of core updates for that target — the marked
 *                     escape hatch). Receives (props, core) so it *can*
 *                     compose. Fall-through on `null`: return null to defer
 *                     to the next candidate / core default.
 *  - "contribute" — add an item to a named collection. Collections are
 *                     registry-owned lists ("palette", "slash", "pages",
 *                     "settings", "contextMenu.message", "contextMenu.session",
 *                     "contextMenu.file", …). Adding a collection is data in
 *                     core, not a new kind.
 *  - "hook"       — interception at instrumented boundaries. Open event
 *                     strings; new seams = new event names, never a registry
 *                     change.
 *  - "service"    — provide/consume named logic. `getService(id)` returns
 *                     the highest-precedence provider; doubles as value
 *                     overrides (core consults services for pluggable values
 *                     like the timestamp formatter).
 *
 * Target chains (§5.2): every registered unit is a target with an ordered
 * chain — [wraps… (outermost first), replace candidates by ascending
 * priority, core default last]. Wraps nest outside-in; the first replace
 * candidate returning non-null wins; `null` falls through to core.
 *
 * Gating (§4): presence = installed, manifest `disabled: true` = paused.
 * The loaders (webui-extensions/index.ts, src/lib/runtimeExtensions.ts)
 * simply never register a paused extension and unregister removed ones —
 * the registry itself is ungated. No config list, no localStorage.
 *
 * Contract (§5.3): target ids, collection ids, service ids are versioned.
 * Renaming/moving one = deliberate version bump + migration note, never a
 * silent break. Core components self-register via `registerTarget` /
 * `autoRegister` at boot — no hand-maintained lists.
 */

// ---------------------------------------------------------------------------
// v2 kinds — the contract
// ---------------------------------------------------------------------------

/** Flow-through tweak of a registered target. Outermost-first ordering. */
export interface WrapExtension<P = Record<string, unknown>> {
  kind: "wrap";
  id: string;
  /** Registered target id this wrap applies to. */
  target: string;
  /** Lower runs outermost. Defaults to 100. */
  order?: number;
  render: (props: P, next: () => ReactNode) => ReactNode;
}

/** Take ownership of a registered target. Ascending-priority chain. */
export interface ReplaceExtension<P = Record<string, unknown>> {
  kind: "replace";
  id: string;
  /** Registered target id this replace applies to. */
  target: string;
  /** Lower is tried first; first non-null wins. Defaults to 100. */
  priority?: number;
  /**
   * Return `null` to fall through to the next candidate (or core).
   * `core` re-invokes the core default with (possibly modified) props.
   */
  render: (props: P, core: (props: P) => ReactNode) => ReactNode | null;
}

/** One item added to a registry-owned named collection. */
export interface ContributeExtension<T = unknown> {
  kind: "contribute";
  id: string;
  /** Collection id, e.g. "palette", "slash", "pages", "contextMenu.message". */
  collection: string;
  item: T;
  /** Lower sorts first. Defaults to 100. */
  order?: number;
}

/** Interception at an instrumented boundary. `event` is an open string. */
export interface HookExtension {
  kind: "hook";
  id: string;
  event: string;
  handler: (ctx: Record<string, unknown>, next: () => void) => void | Promise<void>;
}

/** Named logic provision. Highest `precedence` wins `getService`. */
export interface ServiceExtension<T = unknown> {
  kind: "service";
  id: string;
  /** Service id, e.g. "format.timestamp". */
  service: string;
  value: T;
  /** Higher wins. Defaults to 0. */
  precedence?: number;
}

/** What register() accepts: the five v2 kinds. Nothing else. */
export type ExtInput =
  | WrapExtension<Record<string, unknown>>
  | ReplaceExtension<Record<string, unknown>>
  | ContributeExtension<unknown>
  | HookExtension
  | ServiceExtension<unknown>;

// ---------------------------------------------------------------------------
// Collection item shapes — the data half of the contract
// ---------------------------------------------------------------------------
// `contribute` items are untyped at the registry boundary (`item: unknown`);
// these interfaces document what core actually reads per collection, so
// producers and consumers agree without importing each other's modules.

/** Item for the "palette" collection (command palette + keybinds). */
export interface PaletteContribution {
  title: string;
  run: (ctx: { sessionID?: string }) => void;
  keybind?: string;
}

/** Item for the "slash" collection (Composer `/name` entries). */
export interface SlashContribution {
  name: string;
  description?: string;
  aliases?: string[];
  run: (args: string, ctx: { sessionID?: string }) => void | Promise<void>;
}

/** Item for the "pages" collection (full surfaces at `/ext/{id}`). */
export interface PageContribution {
  title: string;
  description?: string;
  render: (ctx: { sessionID?: string }) => ReactNode;
}

/** Item for the "settings" collection (Settings › Extensions sections). */
export interface SettingsContribution {
  title: string;
  description?: string;
  render: () => ReactNode;
}

/** Item for the "contextMenu.message/session/file" collections. */
export interface ContextMenuContribution {
  label: string;
  run: (ctx: { sessionID?: string; messageID?: string }) => void;
}

/** Item for the "message.decoration" collection (row under the body). */
export interface MessageDecorationContribution {
  render: (ctx: { messageID: string; message: MessageInfo }) => ReactNode | null;
}

/** Item for the "message.part" collection (inline below one content part). */
export interface MessagePartContribution {
  render: (ctx: {
    messageID: string;
    message: MessageInfo;
    part: ToolPart;
    partIndex: number;
  }) => ReactNode | null;
}

/** Internal storage: v2 entries only. */
type StoredExt =
  | WrapExtension<Record<string, unknown>>
  | ReplaceExtension<Record<string, unknown>>
  | ContributeExtension<unknown>
  | HookExtension
  | ServiceExtension<unknown>;

const registry: StoredExt[] = [];

/** Core defaults: target id → default render. Self-registered at boot. */
const coreTargets = new Map<string, (props: Record<string, unknown>) => ReactNode>();

/**
 * Registry mutations are observable so extension hot updates repaint
 * WITHOUT a page reload: an edited extension module re-registers with the
 * same id, `register()` swaps it in and bumps the version, and every
 * mounted Target re-reads the fresh render fns.
 */
let registryVersion = 0;
const listeners = new Set<() => void>();

export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyRegistryChange() {
  registryVersion++;
  for (const listener of listeners) listener();
}

/**
 * Unregister everything under the given ids — called by the loaders when a
 * folder is deleted/moved or paused via manifest `disabled: true`, so the
 * entries disappear without a page reload. Core targets are never
 * unregistered (they are core, not extensions).
 */
export function unregisterIds(ids: string[]) {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  let removed = false;
  for (let i = registry.length - 1; i >= 0; i--) {
    if (drop.has(registry[i]!.id)) {
      registry.splice(i, 1);
      removed = true;
    }
  }
  if (removed) notifyRegistryChange();
}

/** Every id currently holding registrations (built-in + runtime). */
export function getRegisteredIds(): string[] {
  return registry.map((e) => e.id);
}

// ---------------------------------------------------------------------------
// v2 core API: targets, contributions, services, hooks
// ---------------------------------------------------------------------------

/**
 * Register a core default render for a single target id — the primitive.
 * Called by core components at module boot (`autoRegister` below is the
 * batch helper over this for groups). Re-registering the
 * same id swaps the default (HMR-safe).
 */
export function registerTarget(
  target: string,
  render: (props: Record<string, unknown>) => ReactNode,
) {
  coreTargets.set(target, render);
  notifyRegistryChange();
}

/**
 * Auto-registration helper (§5.3): the batch form of `registerTarget` —
 * register a batch of core defaults in one call (one notify) instead of one
 * `registerTarget` per target — no hand-maintained lists. A core module calls this once at the top
 * level with every tweakable unit it owns (leaves, not just roots):
 *
 *   autoRegister({ "message.timestamp": (p) => <Timestamp {...p} />, ... });
 */
export function autoRegister(
  targets: Record<string, (props: Record<string, unknown>) => ReactNode>,
) {
  for (const [target, render] of Object.entries(targets)) {
    coreTargets.set(target, render);
  }
  notifyRegistryChange();
}

/** Ordered chain for one target: wraps outermost-first, replaces by priority. */
export interface TargetChain {
  wraps: WrapExtension<Record<string, unknown>>[];
  replaces: ReplaceExtension<Record<string, unknown>>[];
  core: ((props: Record<string, unknown>) => ReactNode) | undefined;
}

export function getTargetChain(target: string): TargetChain {
  const wraps = registry
    .filter(
      (e): e is WrapExtension<Record<string, unknown>> =>
        e.kind === "wrap" && e.target === target,
    )
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  const replaces = registry
    .filter(
      (e): e is ReplaceExtension<Record<string, unknown>> =>
        e.kind === "replace" && e.target === target,
    )
    .sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id),
    );
  return { wraps, replaces, core: coreTargets.get(target) };
}

/** True when the target has a core default or any wrap/replace entries. */
export function hasTarget(target: string): boolean {
  if (coreTargets.has(target)) return true;
  return registry.some(
    (e) =>
      (e.kind === "wrap" || e.kind === "replace") &&
      (e as WrapExtension | ReplaceExtension).target === target,
  );
}

function renderChainLeaf(
  chain: TargetChain,
  props: Record<string, unknown>,
): ReactNode {
  const core = chain.core ?? (() => null);
  for (const r of chain.replaces) {
    let out: ReactNode | null = null;
    try {
      out = r.render(props, core);
    } catch (err) {
      console.error(`[extensions] replace "${r.id}" crashed:`, err);
      continue;
    }
    if (out !== null) return out;
  }
  try {
    return core(props);
  } catch (err) {
    console.error(`[extensions] core target crashed:`, err);
    return null;
  }
}

function renderWithWraps(
  wraps: WrapExtension<Record<string, unknown>>[],
  index: number,
  props: Record<string, unknown>,
  leaf: () => ReactNode,
): ReactNode {
  if (index >= wraps.length) return leaf();
  const w = wraps[index]!;
  try {
    return w.render(props, () => renderWithWraps(wraps, index + 1, props, leaf));
  } catch (err) {
    console.error(`[extensions] wrap "${w.id}" crashed, falling through:`, err);
    return renderWithWraps(wraps, index + 1, props, leaf);
  }
}

/**
 * Evaluate a target chain to a node. Call during render (it invokes user
 * wrap/replace fns). Wraps nest outermost-first; the first replace
 * returning non-null wins; `null` falls through to the core default.
 */
const warnedNoCore = new Set<string>();
export function renderTarget(target: string, props: Record<string, unknown> = {}): ReactNode {
  const chain = getTargetChain(target);
  if (!chain.core && chain.replaces.length === 0 && !warnedNoCore.has(target)) {
    warnedNoCore.add(target);
    console.warn(
      `[extensions] target "${target}" has no core default — its module's autoRegister never ran (is it imported at boot?). Rendering null.`,
    );
  }
  return renderWithWraps(chain.wraps, 0, props, () => renderChainLeaf(chain, props));
}

/**
 * The universal target marker: evaluates the registered chain for `id`.
 * Extra props flow to wraps / replaces / core. Repaints live on registry
 * swaps. Crash-isolated per target so one broken extension cannot blank
 * the surrounding tree.
 */
export function Target(props: { id: string; [key: string]: unknown }): ReactNode {
  useSyncExternalStore(subscribeRegistry, () => registryVersion);
  const { id, ...rest } = props;
  return (
    <TargetErrorBoundary id={id}>
      {renderTarget(id, rest as Record<string, unknown>)}
    </TargetErrorBoundary>
  );
}

/**
 * Items contributed to a named collection, sorted by order then id.
 * Collections are data ("palette", "slash", "pages", "settings",
 * "contextMenu.message", …) — never new kinds.
 */
export function getContributions<T = unknown>(
  collection: string,
): { id: string; item: T; order: number }[] {
  return registry
    .filter(
      (e): e is ContributeExtension<T> =>
        e.kind === "contribute" && e.collection === collection,
    )
    .map((e) => ({ id: e.id, item: e.item, order: e.order ?? 100 }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * Consume a named logic service. Highest `precedence` wins — this doubles
 * as value overrides: core consults services for pluggable values (e.g.
 * the timestamp formatter) so tiny logic tweaks stay stale-proof.
 */
export function getService<T = unknown>(id: string): T | undefined {
  let best: ServiceExtension<T> | undefined;
  let bestPrecedence = -Infinity;
  for (const e of registry) {
    if (e.kind !== "service") continue;
    const s = e as ServiceExtension<T>;
    if (s.service !== id) continue;
    const p = s.precedence ?? 0;
    if (p > bestPrecedence) {
      best = s;
      bestPrecedence = p;
    }
  }
  return best?.value;
}

/** Every provider for a service id, highest precedence first. */
export function getServiceProviders<T = unknown>(
  id: string,
): { id: string; value: T; precedence: number }[] {
  return registry
    .filter(
      (e): e is ServiceExtension<T> =>
        e.kind === "service" && e.service === id,
    )
    .map((e) => ({ id: e.id, value: e.value, precedence: e.precedence ?? 0 }))
    .sort((a, b) => b.precedence - a.precedence || a.id.localeCompare(b.id));
}

export function getHooks(event: string): HookExtension[] {
  return registry.filter(
    (e): e is HookExtension => e.kind === "hook" && e.event === event,
  );
}

/**
 * NOTE: the live hook runner is `fireHooks` in `./hooks` (sequential,
 * crash-isolated; `next()` is accepted but a no-op — every handler runs).
 * It lives there, not here, so this module has no runner of its own: one
 * method per concern, no divergent duplicates.
 */

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

/**
 * Register one v2 extension entry. Same-id re-registration swaps in place
 * (hot-swap, no reload). There are no legacy kinds: `region`, `message`,
 * `message.decoration`, `message.part`, `tool.renderer`, `command`,
 * `slash`, `page`, `settings`, `contextMenu` are gone — use
 * wrap / replace / contribute (spec §10).
 */
export function register(ext: ExtInput) {
  const stored = ext as StoredExt;
  const existing = registry.findIndex((e) => e.id === stored.id);
  if (existing !== -1) {
    const prev = registry[existing]!;
    if (prev.kind !== stored.kind || (prev as { target?: unknown }).target !== (stored as { target?: unknown }).target) {
      console.warn(
        `[extensions] id "${stored.id}" re-registered as ${stored.kind} (was ${prev.kind}) — same-id re-register SWAPS, so the previous entry is gone. Use distinct ids per entry.`,
      );
    }
    registry[existing] = stored;
    notifyRegistryChange();
    return;
  }
  registry.push(stored);
  notifyRegistryChange();
}

/**
 * One broken extension must not blank the tree it renders into —
 * crash isolation is per target item; the rest keeps working.
 */
export class TargetErrorBoundary extends Component<
  { children: ReactNode; id: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error(`[extensions] target "${this.props.id}" crashed:`, err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
