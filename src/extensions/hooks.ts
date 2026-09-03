import { getHooks } from "./registry";

/**
 * Shared hook runner for `kind: "hook"` extensions (spec §5.1).
 *
 * Events are OPEN strings — firing a new event name here needs no registry
 * change. Handlers run sequentially in registration order so a pre-hook can
 * mutate `ctx` before the core action reads it; each handler is
 * crash-isolated (a throwing extension never breaks the core path).
 *
 * Sync call sites (e.g. the store middleware) use `void fireHooks(...)`;
 * interception sites (api pre-hooks, session.prompt) `await` it so ctx
 * mutations apply before the action proceeds. The one exception is
 * `message.render`: MessageItem reads `getHooks` directly and runs handlers
 * inline so render stays sync — do not route it through here.
 */
export async function fireHooks(event: string, ctx: Record<string, unknown>): Promise<void> {
  const hooks = getHooks(event);
  if (hooks.length === 0) return;
  for (const h of hooks) {
    try {
      await h.handler(ctx, () => {});
    } catch (err) {
      console.error(`[extensions] hook "${h.id}" (${event}) failed:`, err);
    }
  }
}
