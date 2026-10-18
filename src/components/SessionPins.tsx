import { Pin, PinOff } from "lucide-react";
import { Spinner } from "./ui";
import { autoRegister } from "../extensions/registry";
import type { PinRef } from "../lib/sessionTabs";

/**
 * Pins / quick slots for the sidebar (parity.md §5 R3, §3.1).
 *
 * v2 keeps a set of PINNED sessions reachable by number
 * (`session.quick_switch.1..9`, `session.pin.toggle` = `ctrl+f` in the session
 * list). When tabs are disabled, pins "take over" as the primary switcher —
 * this rail is that affordance. Rendered by the Sidebar through
 * `<Target id="sidebar.sessionPins">`.
 *
 * Presentational: `pins` (built by `lib/sessionTabs.ts`) and callbacks arrive
 * as props; the store owns the model. The quick-slot NUMBER in each session
 * row is a separate Sidebar concern (the row gets `quickSlot`/`pinned` props —
 * see the R3 report), so this rail only lists what is pinned.
 */

export interface SessionPinsProps {
  /** Pinned sessions in slot order (slot = index + 1, 1..9). */
  pins: PinRef[];
  /** When false, tabs are off and pins are the primary switcher. */
  tabsEnabled: boolean;
  selected?: string | null;
  /** `session.quick_switch.N` — 1-based slot. */
  onSelectSlot: (slot: number) => void;
  onUnpin: (sessionID: string) => void;
  onToggleTabs: () => void;
  /** Optional "pin the focused session" affordance. */
  onPinCurrent?: () => void;
}

function PinIndicators({ pin }: { pin: PinRef }) {
  const { indicators: ind } = pin;
  if (!ind.busy && !ind.permission && !ind.question && !ind.error && !ind.unread) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" aria-hidden>
      {ind.permission && (
        <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-[color:var(--surface-warning-base)] font-mono text-[9px] font-bold leading-none text-[var(--surface-warning-strong)]">
          !
        </span>
      )}
      {ind.question && (
        <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-[color:var(--surface-info-base)] font-mono text-[9px] font-bold leading-none text-[var(--surface-info-strong)]">
          ?
        </span>
      )}
      {ind.busy && <Spinner className="size-3 text-[var(--surface-brand-base)]" />}
      {ind.unread && (
        <span
          className={`size-1.5 rounded-full bg-[var(--surface-warning-strong)] ${ind.pulse ? "animate-pulse" : ""}`}
        />
      )}
    </span>
  );
}

export function SessionPins({
  pins,
  tabsEnabled,
  selected,
  onSelectSlot,
  onUnpin,
  onToggleTabs,
  onPinCurrent,
}: SessionPinsProps) {
  // Nothing pinned → render NOTHING at all: no "Pinned · quick switch" header
  // and no "pin one" copy. The rail is additive, not a permanent chrome. When
  // tabs are off with no pins, Settings › Appearance is the way back (the
  // tab→pins switch shows a one-time pointer to it — see App).
  if (pins.length === 0) return null;

  const isCurrent = (sessionID: string) => sessionID === selected;

  return (
    <div
      data-oc-session-pins
      data-oc-tabs-enabled={tabsEnabled ? "true" : "false"}
      className="flex min-w-0 flex-col gap-0.5 border-b border-[var(--border-weak-base)] px-2 py-1.5"
    >
      <div className="mb-0.5 flex items-center gap-1">
        <Pin className="size-3 shrink-0 text-[var(--text-weaker)]" />
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-weaker)]">
          {tabsEnabled ? "Pinned" : "Pinned · quick switch"}
        </span>
        {onPinCurrent && (
          <button
            type="button"
            data-oc-pin-current
            title="Pin the current session (Ctrl+F)"
            aria-label="Pin the current session"
            onClick={onPinCurrent}
            className="shrink-0 cursor-pointer rounded-sm p-0.5 text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <Pin className="size-3" />
          </button>
        )}
        <button
          type="button"
          data-oc-pins-toggle-tabs
          title={tabsEnabled ? "Use pins instead of tabs" : "Use session tabs"}
          aria-label={tabsEnabled ? "Use pins instead of tabs" : "Use session tabs"}
          onClick={onToggleTabs}
          className="shrink-0 cursor-pointer rounded-sm border border-[var(--border-weak-base)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)]"
        >
          {tabsEnabled ? "pins" : "tabs"}
        </button>
      </div>

      {pins.map((pin) => (
        <button
          key={pin.sessionID}
          type="button"
          data-oc-pin
          data-oc-pin-slot={pin.slot}
          data-oc-pin-id={pin.sessionID}
          data-oc-pin-status={pin.status}
          title={`${pin.slot}. ${pin.title}`}
          onClick={() => onSelectSlot(pin.slot)}
          className={`group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors ${
            isCurrent(pin.sessionID)
              ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
              : "text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          } ${
            pin.indicators.attention
              ? "ring-1 ring-[color-mix(in_oklch,var(--surface-warning-strong)_45%,transparent)]"
              : ""
          }`}
        >
          <span className="w-3 shrink-0 text-center font-mono text-[10px] text-[var(--text-weaker)]" data-oc-pin-number>
            {pin.slot}
          </span>
          <span className="min-w-0 flex-1 truncate">{pin.title}</span>
          <PinIndicators pin={pin} />
          <span
            role="button"
            aria-label={`Unpin ${pin.title}`}
            title="Unpin"
            onClick={(e) => {
              e.stopPropagation();
              onUnpin(pin.sessionID);
            }}
            className="invisible shrink-0 cursor-pointer rounded-sm p-0.5 text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)] group-hover:visible"
          >
            <PinOff className="size-3" />
          </span>
        </button>
      ))}
    </div>
  );
}

// Self-registration (spec §5.3): the Sidebar renders this through
// <Target id="sidebar.sessionPins">.
autoRegister({
  "sidebar.sessionPins": (p) => <SessionPins {...(p as unknown as SessionPinsProps)} />,
});
