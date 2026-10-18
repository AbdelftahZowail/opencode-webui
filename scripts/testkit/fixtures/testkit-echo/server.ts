/**
 * testkit-echo — proxy stratum (fixture).
 *
 * Three routes + an event tap, exercising the whole proxy mount surface:
 *   GET  /api/webui/ext/testkit-echo/echo    -> a JSON marker (route proof)
 *   POST /api/webui/ext/testkit-echo/kv      -> ctx.kv.set (KV write)
 *   GET  /api/webui/ext/testkit-echo/kv      -> ctx.kv.all (KV read)
 *   GET  /api/webui/ext/testkit-echo/events  -> how many engine events the
 *                                               always-on tap has seen
 *
 * Types are declared locally (no core imports) to keep the module standalone —
 * structural validation is all the loader does (server/ext/registry.ts).
 */

interface ExtKV {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
  all(): Record<string, unknown>;
}

interface RouteCtx {
  extID: string;
  kv: ExtKV;
  url: URL;
}

/** Proxy-stratum state: survives across requests for the life of the module. */
let eventCount = 0;
let lastEventType = "";

export default {
  routes: [
    {
      method: "GET",
      path: "echo",
      handler: async (req: Request, ctx: RouteCtx): Promise<Response> =>
        Response.json({
          extension: ctx.extID,
          marker: "TESTKIT_ECHO_PROXY",
          path: ctx.url.pathname,
          method: req.method,
        }),
    },
    {
      method: "POST",
      path: "kv",
      handler: async (req: Request, ctx: RouteCtx): Promise<Response> => {
        const body = (await req.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
        if (typeof body.key !== "string") {
          return Response.json({ error: "key (string) required" }, { status: 400 });
        }
        await ctx.kv.set(body.key, body.value);
        return Response.json({ ok: true, key: body.key });
      },
    },
    {
      method: "GET",
      path: "kv",
      handler: async (_req: Request, ctx: RouteCtx): Promise<Response> =>
        Response.json({ data: ctx.kv.all() }),
    },
    {
      method: "GET",
      path: "events",
      handler: async (): Promise<Response> =>
        Response.json({ count: eventCount, last: lastEventType }),
    },
  ],

  // The always-on proxy event tap: fires for every engine event the recorder
  // sees, with no browser attached. Counting proves the strand is live.
  onEvent: async (evt: { type?: string }): Promise<void> => {
    eventCount += 1;
    lastEventType = typeof evt?.type === "string" ? evt.type : "";
  },
};
