/**
 * Proxy stratum types (spec §8).
 *
 * A `server.ts` (or `server/` dir with an index) in an extension folder may
 * provide any of: `routes`, `middleware`, `onEvent`, `pollers`. The module
 * default-exports the object — NO import needed on the extension side; the
 * loader validates the shape structurally (`isServerExtensionModule`) so
 * extensions never depend on a resolvable core path.
 *
 * ```ts
 * // my-extension/server.ts
 * export default {
 *   routes: [
 *     {
 *       method: "POST", path: "notify",
 *       handler: async (req, ctx) => {
 *         await ctx.kv.set("lastPing", Date.now());
 *         return Response.json({ ok: true });
 *       },
 *     },
 *   ],
 *   onEvent: async (evt) => { / headless reaction, all tabs closed / },
 *   pollers: [
 *     { id: "keepalive", intervalMs: 60_000, run: async () => {} },
 *   ],
 * };
 * ```
 */

import type { ExtKV } from "./kv";

/** Engine event tapped from the recorder's always-on subscription. */
export interface ExtEngineEvent {
  id: string;
  type: string;
  data: unknown;
}

/** Per-request context for routes, middleware, and pollers. */
export interface ExtServerContext {
  /** This extension's id (folder name / manifest id). */
  extID: string;
  /** Namespaced persistent KV (JSON-file backed, see kv.ts). */
  kv: ExtKV;
  /**
   * Engine fetch helper (see `engine.ts`). Replaces hand-parsing
   * `service.json`: `await ctx.engine.fetch("/api/session/active")`.
   * Honors `WEBUI_ENGINE_URL` / `WEBUI_ENGINE_PASSWORD` (explicit env
   * wins); auth headers always win over caller-supplied ones.
   */
  engine: ExtEngine;
}

/**
 * Engine credential helper (implemented in `engine.ts`, node builtins only
 * — no core import needed on the extension side; the context is structural).
 */
export interface ExtEngine {
  /** Effective engine base URL (`WEBUI_ENGINE_URL` wins, else `service.json`). `null` when undiscoverable. */
  baseUrl(): string | null;
  /** Auth headers for the engine (Basic `opencode:<password>`), or `{}` when unauthenticated. */
  headers(): Record<string, string>;
  /**
   * Fetch against the engine (`/api/...` paths; leading slash optional).
   * Throws with a remedy when undiscoverable; HTTP errors are returned, not
   * thrown. Aborts after 15s unless the caller passes its own signal.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** Extra context for route handlers. */
export interface ExtRouteContext extends ExtServerContext {
  /** Full request URL (parsed). */
  url: URL;
  /** Suffix segments after `/api/webui/ext/<id>/`. */
  params: string[];
}

export interface ExtRoute {
  /** Defaults to "GET". */
  method?: string;
  /** Suffix path, e.g. `"notify"` or `"hooks/session-finished"`. */
  path: string;
  handler: (req: Request, ctx: ExtRouteContext) => Response | Promise<Response>;
}

export interface ExtMiddleware {
  /**
   * Runs BEFORE the `/api/*` passthrough. Return a Response to
   * short-circuit (serve directly); return a Request to replace the
   * outgoing request (header/query transforms); return void to pass
   * through untouched. Affects ALL clients — unlike browser hooks, which
   * only affect their own browser.
   */
  onRequest?: (req: Request, ctx: ExtServerContext) => Request | Response | void | Promise<Request | Response | void>;
  /**
   * Runs AFTER the upstream responded, before the browser sees it. Return
   * a Response to replace (uniform rewriting, rate-limit headers, …).
   */
  onResponse?: (
    res: Response,
    req: Request,
    ctx: ExtServerContext,
  ) => Response | void | Promise<Response | void>;
}

export interface ExtPoller {
  /** Unique within the extension (used for hot-swap restart). */
  id: string;
  intervalMs: number;
  run: (ctx: ExtServerContext) => void | Promise<void>;
}

/** Everything a proxy-stratum module may provide. All fields optional. */
export interface ServerExtensionModule {
  routes?: ExtRoute[];
  middleware?: ExtMiddleware;
  /** Tap into the always-on engine event subscription (headless). */
  onEvent?: (evt: ExtEngineEvent, ctx: ExtServerContext) => void | Promise<void>;
  /** Always-on ticks that survive closed tabs. */
  pollers?: ExtPoller[];
  /** Called on hot-swap/dispose so timers/sockets don't leak. */
  dispose?: () => void;
}
