import { useState } from "react";
import { ArrowUpCircle, CheckCircle2, RefreshCw, Rocket, X } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import {
  shouldShowUpdateNotice,
  updateNoticeActions,
  updateNoticeMessage,
  type UpdateNoticeState,
} from "../lib/updateNotice";
import { Spinner } from "./ui";

export type { UpdateNoticeState } from "../lib/updateNotice";

/**
 * R11 — Update notification (v2 `dialog-update.tsx` +
 * `context/update-notification.tsx`).
 *
 * States: checking · available · installing · installed · current ·
 * unavailable · failed. Skip / Update / Restart per state.
 *
 * Presentational + a tiny local de-dup: the orchestrator owns the check +
 * install side effects and the persisted `dismissedVersion`; this component
 * additionally remembers an in-session skip so the SAME version never re-fires
 * while mounted. The pure rule lives in `lib/updateNotice.ts`.
 *
 * Targets: `update.notice`.
 */

export interface UpdateNoticeProps {
  state: UpdateNoticeState;
  /** The offered / installing version. */
  version?: string | null;
  /** The version currently running (shown while offering). */
  currentVersion?: string | null;
  /** Failure detail for the `failed` state. */
  error?: string | null;
  /** Version the user already skipped, persisted by the caller. */
  dismissedVersion?: string | null;
  /** Persist "never show this version again". */
  onSkip?: (version: string) => void;
  /** Begin installing the offered version. */
  onUpdate?: () => void;
  /** Restart to apply an installed version. */
  onRestart?: () => void;
  /** Retry after a failure. */
  onRetry?: () => void;
  /** Plain dismiss (failed/unavailable cards). */
  onClose?: () => void;
}

export function UpdateNotice({
  state,
  version,
  currentVersion,
  error,
  dismissedVersion,
  onSkip,
  onUpdate,
  onRestart,
  onRetry,
  onClose,
}: UpdateNoticeProps) {
  const [sessionSkip, setSessionSkip] = useState<string | null>(null);
  const dismissed = sessionSkip ?? dismissedVersion ?? null;

  if (!shouldShowUpdateNotice({ state, version, dismissedVersion: dismissed })) return null;

  const actions = updateNoticeActions(state);
  const busy = state === "installing";

  const dismiss = () => {
    if (state === "available" && version) {
      setSessionSkip(version);
      onSkip?.(version);
      return;
    }
    onClose?.();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-oc-update-notice
      data-oc-update-state={state}
      className="fixed right-4 bottom-4 z-[55] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 rounded-xl border border-[var(--border-base)] bg-[var(--surface-float-base)] p-3 shadow-2xl duration-150 animate-in fade-in slide-in-from-bottom-2"
    >
      <div className="flex items-start gap-2">
        <Icon state={state} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[var(--text-strong)]">OpenCode update</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-weak)]">
            {updateNoticeMessage(state, version)}
          </p>
          {state === "available" && currentVersion && (
            <p className="mt-0.5 font-mono text-[10px] text-[var(--text-weaker)]">
              current {currentVersion}
            </p>
          )}
          {state === "failed" && error && (
            <p className="mt-1 break-words font-mono text-[10px] text-[var(--surface-critical-strong)]">
              {error}
            </p>
          )}
        </div>
        {!busy && (
          <button
            type="button"
            onClick={dismiss}
            title="Dismiss"
            aria-label="Dismiss update notice"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {actions.length > 0 && (
        <div className="flex items-center justify-end gap-2">
          {actions.includes("skip") && (
            <button
              type="button"
              data-oc-update-skip
              onClick={dismiss}
              className="cursor-pointer rounded-md px-2 py-1 text-xs text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)]"
            >
              Skip
            </button>
          )}
          {actions.includes("retry") && (
            <button
              type="button"
              data-oc-update-retry
              onClick={onRetry}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
            >
              <RefreshCw className="size-3.5" />
              Retry
            </button>
          )}
          {actions.includes("update") && (
            <button
              type="button"
              data-oc-update-update
              onClick={onUpdate}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-[var(--button-primary-base)] px-2.5 py-1 text-xs font-medium text-[var(--background-base)]"
            >
              <Rocket className="size-3.5" />
              Update
            </button>
          )}
          {actions.includes("restart") && (
            <button
              type="button"
              data-oc-update-restart
              onClick={onRestart}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-[var(--button-primary-base)] px-2.5 py-1 text-xs font-medium text-[var(--background-base)]"
            >
              <RefreshCw className="size-3.5" />
              Restart
            </button>
          )}
          {actions.includes("close") && (
            <button
              type="button"
              data-oc-update-close
              onClick={dismiss}
              className="cursor-pointer rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
            >
              Close
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Icon({ state }: { state: UpdateNoticeState }) {
  if (state === "installing") return <Spinner className="mt-0.5 size-4 shrink-0" />;
  if (state === "installed") return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--surface-success-strong)]" />;
  return <ArrowUpCircle className="mt-0.5 size-4 shrink-0 text-[var(--text-interactive-base)]" />;
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "update.notice": (p) => <UpdateNotice {...(p as unknown as UpdateNoticeProps)} />,
});
