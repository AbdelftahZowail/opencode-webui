/**
 * R9 — SESSION-level usage details bar, pinned under the composer.
 *
 * One small mono row below the composer input showing what the engine really
 * reports for the whole session: the active model, fresh (uncached) input,
 * cached input, output (+ reasoning), the LATEST TURN's generation speed
 * (`tok/s` — the TUI's `session.tps` figure, see `turnTps`), total, the
 * cache-hit rate, session cost,
 * and — with a small meter — the CURRENT context occupancy. The context
 * reading is the LAST assistant message's total tokens against the model's
 * context window, exactly the number the composer used to show inline; it is
 * never the sum of every step (that is what made the old per-turn bar read
 * 100% while the composer read 35%).
 *
 * There is deliberately NO system / tools / messages segmentation: the engine
 * (`src/api/types.ts` `TokenUsage`) exposes only `input`, `output`,
 * `reasoning`, and `cache.{read,write}` — no per-segment breakdown — so the
 * DSH-style 3-segment pressure bar cannot be reproduced faithfully here. The
 * context meter below is therefore a SINGLE segment.
 *
 * Core default for the `composer.usageBar` target; the composer renders it
 * through `<Target id="composer.usageBar" …>`, so a wrap/replace can restyle
 * it without touching the composer.
 *
 * Anchor: `data-oc-composer-usage`.
 */

import { useMemo, useSyncExternalStore } from "react";
import { autoRegister } from "../extensions/registry";
import { aggregateTokens, formatTokens, turnSteps, turnTps } from "../lib/grouping";
import { getModels, subscribeCatalog } from "../lib/modelCatalog";
import type { AssistantMessage, MessageInfo, ModelRef } from "../api/types";

/** Resolve a model's context window from the shared (prefetched) catalog. */
function contextLimitFor(
  ref: ModelRef | undefined,
  models: ReturnType<typeof getModels>,
): number | undefined {
  if (!ref) return undefined;
  return models.find(
    (m) => m.enabled && m.modelID === ref.id && m.providerID === ref.providerID,
  )?.limit?.context;
}

export function ComposerUsageBar({
  messages,
  model,
  fallbackCost,
}: {
  /** The session's full message list (the store's `messages[sessionID]`). */
  messages?: MessageInfo[];
  /** The session's ACTIVE model (the store's `detail.model`) — context source. */
  model?: ModelRef;
  /** Session-cost fallback (the store's `detail.cost`) when no message reports one. */
  fallbackCost?: number;
}) {
  const models = useSyncExternalStore(subscribeCatalog, getModels, getModels);
  const assistant = useMemo(
    () => (messages ?? []).filter((m): m is AssistantMessage => m.type === "assistant"),
    [messages],
  );
  // Session-level aggregation over every assistant step the engine reported.
  const usage = aggregateTokens(turnSteps(assistant));
  if (usage.steps === 0) return null;

  // CURRENT context occupancy: the LAST assistant message's total tokens —
  // never the sum of every step. This mirrors the composer's former `pct`
  // (lastAssistant total ÷ limit.context) byte for byte.
  let last: AssistantMessage | undefined;
  for (let i = assistant.length - 1; i >= 0; i--) {
    const m = assistant[i]!;
    if (m.tokens) {
      last = m;
      break;
    }
  }
  const tokens = last?.tokens;
  const contextTokens = tokens
    ? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    : undefined;
  const ref = model ?? last?.model;
  const limit = contextLimitFor(ref, models);
  const pct =
    contextTokens !== undefined && limit
      ? Math.round((contextTokens / limit) * 100)
      : undefined;

  // Cache-hit rate: cached ÷ (new + cached), guarded against divide-by-zero.
  const promptTokens = usage.newTokens + usage.cachedTokens;
  const cacheHit = promptTokens > 0 ? Math.round((usage.cachedTokens / promptTokens) * 100) : undefined;

  // Latest turn's generation speed — the engine's own `tok/s` (the TUI's
  // `session.tps` footer figure), computed whole-turn over the steps the engine
  // has reported (see `turnTps`). Re-derived on every store refresh, so it
  // advances as each step of the turn settles.
  const tps = turnTps(messages ?? []);

  // Session cost: the sum of assistant costs, falling back to the session
  // detail's own cost when no message carries one.
  const summedCost = assistant.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  const cost = summedCost > 0 ? summedCost : fallbackCost && fallbackCost > 0 ? fallbackCost : undefined;

  return (
    <div
      data-oc-composer-usage
      className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-1 font-mono text-[10px] text-[var(--text-weaker)]"
    >
      <span title={`${usage.newTokens.toLocaleString()} new (uncached) input tokens this session`}>
        in {formatTokens(usage.newTokens)}
      </span>
      <span title={`${usage.cachedTokens.toLocaleString()} cached input tokens this session`}>
        cached {formatTokens(usage.cachedTokens)}
      </span>
      <span title={`${usage.outputTokens.toLocaleString()} output + reasoning tokens this session`}>
        out {formatTokens(usage.outputTokens)}
      </span>
      {tps !== undefined && (
        <span title="Latest turn's output + reasoning tokens per second — the engine's own tok/s (same calculation as the TUI footer)">
          {tps.toFixed(1)} tok/s
        </span>
      )}
      <span title={`${usage.totalTokens.toLocaleString()} tokens this session`}>
        total {formatTokens(usage.totalTokens)}
      </span>
      {cacheHit !== undefined && (
        <span title={`${cacheHit}% of prompt tokens were served from cache`}>cache {cacheHit}%</span>
      )}
      {cost !== undefined && (
        <span title="Cost reported for this session">${cost.toFixed(4)}</span>
      )}
      {pct !== undefined && (
        <span
          className="inline-flex items-center gap-1"
          title={`${pct}% of the model's context window in use (current context)`}
        >
          <span className="relative inline-block h-1 w-10 overflow-hidden rounded-full bg-[color:var(--surface-base-hover)]">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--surface-brand-base)]"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          {pct}% ctx
        </span>
      )}
    </div>
  );
}

autoRegister({
  "composer.usageBar": (p) => (
    <ComposerUsageBar
      messages={p.messages as MessageInfo[] | undefined}
      model={p.model as ModelRef | undefined}
      fallbackCost={p.fallbackCost as number | undefined}
    />
  ),
});
