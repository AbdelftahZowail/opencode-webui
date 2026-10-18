/**
 * R9 — per-turn token usage, as a SMALL quiet chip.
 *
 * A tiny `ⓘ N steps` affordance under a turn's response. CLICK the chip to
 * show the details (aggregate line + per-step table); the details CLOSE as soon
 * as the pointer leaves the chip (or the panel) — no hover-open, no sticky pin.
 *
 * The details render as an OVERLAY: a portal to `document.body`, `position:
 * fixed`, anchored just above the chip, so they float over the transcript
 * instead of expanding inline and pushing the list, and are never clipped by
 * the scroller's `contain`/`overflow` (a message item's `content-visibility`
 * stacking context would otherwise hide them). A short grace delay lets the
 * pointer travel from the chip onto the panel without flicker.
 *
 * Core default for the `turn.tokens` target; the transcript
 * (`Conversation.tsx`) computes the turn's steps and renders it through
 * `<Target id="turn.tokens">`, so a wrap/replace can restyle it without
 * touching the transcript loop. Session-level numbers live in the composer's
 * `composer.usageBar`.
 *
 * Anchor: `data-oc-turn-tokens`.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { aggregateTokens, formatTokens, type TurnTokenStep } from "../lib/grouping";
import { formatModelRef } from "../lib/modelLabel";

export function TurnTokens({ steps }: { steps: TurnTokenStep[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number; maxWidth: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const usage = aggregateTokens(steps);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const close = () => {
    cancelClose();
    setOpen(false);
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };
  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxWidth = Math.min(window.innerWidth - 24, 560);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - maxWidth - 12));
    setPos({ left, bottom: window.innerHeight - r.top + 6, maxWidth });
  };
  const toggle = () => {
    if (open) close();
    else {
      place();
      setOpen(true);
    }
  };

  // The panel is fixed-positioned: close it if the page moves underneath it.
  useEffect(() => {
    if (!open) return;
    const onMove = () => setOpen(false);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);
  useEffect(() => () => cancelClose(), []);

  if (usage.steps === 0) return null;
  const stepLabel = usage.steps === 1 ? "step" : "steps";

  return (
    <div data-oc-turn-tokens className="inline-flex">
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        title={open ? "Hide token details" : "Show token details"}
        onClick={toggle}
        onMouseLeave={closeSoon}
        className="inline-flex cursor-pointer items-center gap-1 rounded px-0.5 font-mono text-[10px] text-[var(--text-weaker)] transition-colors hover:text-[var(--text-weak)]"
      >
        <Info className="size-3 shrink-0" />
        <span>
          {usage.steps} {stepLabel}
        </span>
      </button>

      {open && pos &&
        createPortal(
          <div
            data-oc-turn-tokens-panel
            onMouseEnter={cancelClose}
            onMouseLeave={closeSoon}
            style={{ position: "fixed", left: pos.left, bottom: pos.bottom, maxWidth: pos.maxWidth, zIndex: 60 }}
            className="overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--background-strong)] font-mono shadow-[0_8px_28px_rgba(0,0,0,0.4)]"
          >
            <div className="px-2.5 py-1 text-[10px] text-[var(--text-weaker)]">
              Tokens: {usage.steps} {stepLabel} · {formatTokens(usage.newTokens)} new ·{" "}
              {formatTokens(usage.cachedTokens)} cached · {formatTokens(usage.totalTokens)} total
            </div>
            <table className="w-full min-w-[22rem] text-left text-[10px] text-[var(--text-weaker)]">
              <thead>
                <tr className="border-t border-[var(--border-weak-base)]">
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
          </div>,
          document.body,
        )}
    </div>
  );
}

autoRegister({
  "turn.tokens": (p) => <TurnTokens steps={(p.steps as TurnTokenStep[] | undefined) ?? []} />,
});
