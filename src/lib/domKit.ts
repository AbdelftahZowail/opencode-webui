/**
 * DOM stratum kit (spec §7 — the free layer).
 *
 * Wired into the loader (runtimeExtensions.ts mounts/disposes via the same
 * manifest + SSE channel as every other stratum — see gaps at the bottom
 * for what remains):
 * - One entry per extension: `dom.ts` in the extension folder. Its presence
 *   declares DOM-level operation. Same loader, precedence, manifest, gating
 *   as every other stratum.
 * - A `dom.ts` module default-exports `{ mount(kit), dispose? }`. `mount`
 *   runs once the host calls `mountDomExtension(id, module)` (loader or
 *   hot-swap path); it may return a cleanup fn. `disposeDomExtension(id)`
 *   runs every registered cleanup + `dispose`, so hot edits repaint clean
 *   and never stack ghosts.
 * - Framing rule: React-tree change → wrap/replace; DOM-stratum change →
 *   `dom.ts`. Not alternatives for the same job. DOM is the marked last
 *   resort ("outside the contract; you own the fragility").
 *
 * The kit (host-provided, so DOM extensions don't each rebuild this):
 * - `foreign(anchor, nodes, opts?)` — sibling injection with automatic
 *   cleanup when React removes the anchor (foreign-sibling registry).
 *   `opts.position` is "before"|"after" (default "after");
 *   `opts.onRemove` is an optional anchor-death signal (fires once on
 *   auto-cleanup, never on manual dispose).
 * - `watch(selectors, cb)` — React-aware MutationObserver wrapper, including
 *   the streaming-settled signal (`onStreamingSettled`).
 * - `styles(css)` — scoped `<style>` element, auto-removed on
 *   disable/hot-swap.
 *
 * STABLE ANCHORS (our half of the bargain — stamped into core markup,
 * one attribute per site, versioned like registry target ids):
 *
 * | Anchor attribute              | Site (file)                              |
 * |-------------------------------|------------------------------------------|
 * | `data-oc-transcript`          | MessageScroller content, Conversation.tsx |
 * | `data-oc-message` +           | MessageItem root per type branch          |
 * | `data-oc-message-id`,         | (same; id = message.id)                   |
 * | `data-oc-message-type`        | (user|assistant|…)                        |
 * | `data-oc-composer`            | Composer root card, Composer.tsx          |
 * | `data-oc-composer-input`      | composer textarea                         |
 * | `data-oc-composer-send`       | composer send button                      |
 * | `data-oc-tool-card` +         | ToolCard root, ToolCard.tsx               |
 * | `data-oc-tool-name`           | (tool call name, e.g. "edit")             |
 * | `data-oc-session-header`      | Conversation header bar                   |
 * | `data-oc-sidebar`             | Sidebar root, Sidebar.tsx                 |
 * | `data-oc-queue-strip`         | QueueStrip (steer/queue rows)             |
 * | `data-oc-subagent-strip`      | SubagentStrip                             |
 * | `data-oc-runs-panel`          | RunsPanel                                 |
 *
 * Anchors are versioned like registry target ids: renaming/moving one is a
 * contract bump with a migration note, never a silent break. Without stable
 * anchors DOM extensions break silently on every redesign.
 *
 * GAPS (not in this scaffolding):
 * - Loader: `dom.ts` discovery/bundling/SSE hot-swap (same pipeline as the
 *   `index.tsx` browser stratum, §6) + calling mount/dispose here.
 * - Stamping the `data-oc-*` attributes into the components above.
 */

/** Contract version for the anchor table above. Bump on rename/move. */
export const DOM_STRATUM_VERSION = 1;

/** The proposed stable anchor attributes (values are attribute names). */
export const OC_ANCHORS = {
  transcript: "data-oc-transcript",
  message: "data-oc-message",
  messageId: "data-oc-message-id",
  messageType: "data-oc-message-type",
  composer: "data-oc-composer",
  composerInput: "data-oc-composer-input",
  composerSend: "data-oc-composer-send",
  toolCard: "data-oc-tool-card",
  toolName: "data-oc-tool-name",
  sessionHeader: "data-oc-session-header",
  sidebar: "data-oc-sidebar",
  queueStrip: "data-oc-queue-strip",
  subagentStrip: "data-oc-subagent-strip",
  runsPanel: "data-oc-runs-panel",
} as const;

export type OcAnchor = (typeof OC_ANCHORS)[keyof typeof OC_ANCHORS];

/** Elements freshly matching one of the watched selectors. */
export type WatchCallback = (matched: HTMLElement[], record: MutationRecord) => void;

/** What a `dom.ts` module provides. `mount` may return a cleanup fn. */
export interface DomExtensionModule {
  mount: (kit: DomKit) => void | (() => void) | Promise<void | (() => void)>;
  dispose?: () => void;
}

/** The host-provided kit handed to `mount`. All methods return cleanups. */
export interface DomKit {
  /**
   * Insert `nodes` as siblings of `anchor`; auto-removed if React drops the
   * anchor. `opts.position` selects `before` (insertBefore anchor) or `after`
   * (after anchor, the default — preserves prior callers byte-identically).
   * `opts.onRemove` fires once when anchor-death auto-cleanup runs (React
   * removed the anchor or an ancestor); manual dispose does NOT fire it
   * (the caller already knows). Removal coverage: anchor-death is always
   * watched via MutationObserver — `onRemove` is a notification signal,
   * not a second cleanup path.
   */
  foreign: (
    anchor: Element,
    nodes: Node | Node[],
    opts?: { position?: "before" | "after"; onRemove?: () => void },
  ) => () => void;
  /** Observe `document.body` subtree; `cb` fires with elements matching `selectors`. */
  watch: (selectors: string[], cb: WatchCallback) => () => void;
  /** Append a `<style data-oc-dom-ext="<id>">`; removed on dispose. */
  styles: (css: string) => () => void;
  /**
   * Streaming-settled signal: `cb` fires once no watched-selector mutation
   * has arrived for `quietMs` (token bursts settle before DOM extensions
   * measure/layout).
   */
  onStreamingSettled: (cb: () => void, quietMs?: number) => () => void;
}

type Cleanup = () => void;

/** ext id → cleanups (kit registrations + mount return + dispose). */
const mounted = new Map<string, Cleanup[]>();

function track(id: string, cleanup: Cleanup): Cleanup {
  const list = mounted.get(id) ?? [];
  list.push(cleanup);
  mounted.set(id, list);
  return () => {
    const idx = list.indexOf(cleanup);
    if (idx >= 0) list.splice(idx, 1);
    cleanup();
  };
}

function makeKit(id: string): DomKit {
  return {
    foreign(anchor, nodes, opts) {
      const list = Array.isArray(nodes) ? nodes : [nodes];
      const position = opts?.position ?? "after";
      const onRemove = opts?.onRemove;
      const parent = anchor.parentNode;
      if (!parent) return () => {};
      if (position === "before") {
        for (const n of list) parent.insertBefore(n, anchor);
      } else {
        const next = anchor.nextSibling;
        for (const n of list) parent.insertBefore(n, next);
      }
      const remove = () => {
        for (const n of list) n.parentNode?.removeChild(n);
      };
      // React owns the anchor: when it (or any ancestor up to body) is
      // removed, our foreign siblings are either gone with it or orphaned —
      // clean up either way, then stop observing. onRemove (when provided)
      // fires exactly once on this auto-cleanup path so extensions can drop
      // their own side state; it is crash-isolated and never fires on manual
      // dispose (the caller already knows it removed the nodes).
      const stop = watchRemoval(anchor, () => {
        remove();
        stop();
        if (onRemove) {
          try {
            onRemove();
          } catch (err) {
            console.error(`[dom-ext] onRemove "${id}" failed:`, err);
          }
        }
      });
      const untrackedRemove = () => {
        stop();
        remove();
      };
      return track(id, untrackedRemove);
    },

    watch(selectors, cb) {
      const sel = selectors.join(",");
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const matched: HTMLElement[] = [];
          for (const node of Array.from(record.addedNodes)) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches(sel)) matched.push(node);
            for (const el of Array.from(node.querySelectorAll<HTMLElement>(sel))) {
              matched.push(el);
            }
          }
          if (matched.length > 0) cb(matched, record);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const disconnect = () => observer.disconnect();
      return track(id, disconnect);
    },

    styles(css) {
      const el = document.createElement("style");
      el.setAttribute("data-oc-dom-ext", id);
      el.textContent = css;
      document.head.appendChild(el);
      const remove = () => el.remove();
      return track(id, remove);
    },

    onStreamingSettled(cb, quietMs = 800) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          cb();
        }, quietMs);
      };
      const observer = new MutationObserver(arm);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      arm();
      const disconnect = () => {
        if (timer) clearTimeout(timer);
        observer.disconnect();
      };
      return track(id, disconnect);
    },
  };
}

/** Fires `cb` once `el` (or an ancestor below body) leaves the document. */
function watchRemoval(el: Node, cb: () => void): () => void {
  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) cb();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * Mount a DOM extension: runs `module.mount(kit)` and registers its
 * cleanups under `id`. Re-mounting an already-mounted id disposes it first
 * (hot-swap path — edits repaint clean, never stack ghosts).
 */
export async function mountDomExtension(id: string, module: DomExtensionModule): Promise<void> {
  disposeDomExtension(id);
  mounted.set(id, []);
  const kit = makeKit(id);
  try {
    const cleanup = await module.mount(kit);
    if (typeof cleanup === "function") track(id, cleanup);
  } catch (err) {
    console.error(`[dom-ext] mount "${id}" failed:`, err);
    disposeDomExtension(id);
  }
}

/** Run every cleanup registered under `id` + the module's `dispose`. */
export function disposeDomExtension(id: string, module?: Pick<DomExtensionModule, "dispose">): void {
  const cleanups = mounted.get(id) ?? [];
  mounted.delete(id);
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch (err) {
      console.error(`[dom-ext] cleanup "${id}" failed:`, err);
    }
  }
  try {
    module?.dispose?.();
  } catch (err) {
    console.error(`[dom-ext] dispose "${id}" failed:`, err);
  }
  // Belt-and-braces: no stray style/foreign nodes may survive a hot-swap.
  for (const el of Array.from(document.querySelectorAll(`[data-oc-dom-ext="${CSS.escape(id)}"]`))) {
    el.remove();
  }
}

/** Structural check for a loaded `dom.ts` module (loader-side). */
export function isDomExtensionModule(obj: unknown): obj is DomExtensionModule {
  if (typeof obj !== "object" || obj === null) return false;
  return typeof (obj as { mount?: unknown }).mount === "function";
}
