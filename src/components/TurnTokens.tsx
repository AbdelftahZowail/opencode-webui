/**
 * R9 — per-turn token usage line.
 *
 * A collapsible `+ Tokens: N steps · X new · Y cached · Z total` under a
 * turn's response, expanding to a per-step table (step, model, new, cached,
 * out, total). Core default for the `turn.tokens` target; the transcript
 * (`Conversation.tsx`) computes the turn's steps and renders it through
 * `<Target id="turn.tokens">`, so a wrap/replace can restyle it without
 * touching the transcript loop.
 *
 * Anchor: `data-oc-turn-tokens`.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { aggregateTokens, formatTokens, type TurnTokenStep } from "../lib/grouping";
import { formatModelRef } from "../lib/modelLabel";

export function TurnTokens({ steps }: { steps: TurnTokenStep[] }) {
  const [open, setOpen] = useState(false);
  const usage = aggregateTokens(steps);
  if (usage.steps === 0) return null;
  const stepLabel = usage.steps === 1 ? "step" : "steps";
  return (
    <div
      data-oc-turn-tokens
      className="overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide per-step usage" : "Show per-step usage"}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-[10px] text-[var(--text-weaker)] transition-colors hover:text-[var(--text-weak)]"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span>
          + Tokens: {usage.steps} {stepLabel} · {formatTokens(usage.newTokens)} new ·{" "}
          {formatTokens(usage.cachedTokens)} cached · {formatTokens(usage.totalTokens)} total
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--border-weak-base)]">
          <table className="w-full text-left font-mono text-[10px] text-[var(--text-weaker)]">
            <thead>
              <tr>
                <th className="px-2.5 py-1 font-normal">#</th>
                <th className="px-2 py-1 font-normal">model</th>
                <th className="px-2 py-1 text-right font-normal">new</th>
                <th className="px-2 py-1 text-right font-normal">cached</th>
                <th className="px-2 py-1 text-right font-normal">out</th>
                <th className="px-2.5 py-1 text-right font-normal">total</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step, i) => {
                const one = aggregateTokens([step]);
                return (
                  <tr key={step.id} className="border-t border-[var(--border-weak-base)]">
                    <td className="px-2.5 py-0.5">{i + 1}</td>
                    <td className="max-w-40 truncate px-2 py-0.5">
                      {step.model ? formatModelRef(step.model) : "—"}
                    </td>
                    <td className="px-2 py-0.5 text-right">{formatTokens(one.newTokens)}</td>
                    <td className="px-2 py-0.5 text-right">{formatTokens(one.cachedTokens)}</td>
                    <td className="px-2 py-0.5 text-right">{formatTokens(one.outputTokens)}</td>
                    <td className="px-2.5 py-0.5 text-right">{formatTokens(one.totalTokens)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

autoRegister({
  "turn.tokens": (p) => <TurnTokens steps={(p.steps as TurnTokenStep[] | undefined) ?? []} />,
});
