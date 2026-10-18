import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Megaphone,
  RefreshCw,
  Rocket,
  ShieldAlert,
  X,
} from "lucide-react";
import type { WebuiAnnouncement, WebuiRelease } from "../api/client";
import { autoRegister } from "../extensions/registry";
import { summarizeRelease } from "../lib/notices";
import {
  shouldShowUpdateNotice,
  updateNoticeActions,
  updateNoticeMessage,
  type UpdateNoticeState,
} from "../lib/updateNotice";
import { Spinner } from "./ui";

export type { UpdateNoticeState } from "../lib/updateNotice";

/**
 * R11 — The notice surface (`update.notice`).
 *
 * One fixed, bottom-right card with two jobs, kept in one method:
 *
 *  1. **App update** — the R11 state machine (checking · available ·
 *     installing · installed · current · unavailable · failed). Skip / Update /
 *     Restart per state, with the persisted `dismissedVersion` de-dup.
 *  2. **Product notices** — a hub announcement (ad-hoc message), or the release
 *     note ("What's New") for an offered version. A `security` announcement is
 *     surfaced more loudly, mirroring the release feed's `<!-- security -->`
 *     marker. Dismissal is persisted by the host (`lib/notices.ts`).
 *
 * When an announcement is passed it takes the card (unless an update is
 * mid-install, which the user must act on); the host owns the precedence and the
 * "show the next one" queue.
 *
 * Targets: `update.notice`.
 *
 * The card is the TRANSIENT surface ("you must know now") and stays exactly
 * that: one card at a time, dismissal persisted, no per-login/per-startup
 * gating. A small "Details" affordance on either branch opens the permanent
 * Settings › About page (version / What's New / announcements / usage data),
 * which lists every live item regardless of card dismissal.
 *
 * Responsive: below `sm` the card spans the viewport with side insets and sits
 * above the composer/activity strip (with the keyboard-safe inset), its body
 * scrollable under a capped height; from `sm` up it is the bottom-right card.
 */

export interface UpdateNoticeProps {
  state: UpdateNoticeState;
  /** The offered / installing version. Null when not applicable. */
  version?: string | null;
  /** The version currently running (shown while offering). */
  currentVersion?: string | null;
  /** Failure detail for the `failed` state. */
  error?: string | null;
  /** Version the user already skipped, persisted by the caller. */
  dismissedVersion?: string | null;
  /** When set, the card renders this hub announcement instead of the update. */
  announcement?: WebuiAnnouncement | null;
  /** Release note for the offered version, when the hub feed has it. */
  release?: WebuiRelease | null;
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
  /** Persist an announcement dismissal. */
  onDismissAnnouncement?: (id: number) => void;
  /**
   * Open the permanent Settings › About page (version / What's New /
   * announcements / usage data). The card is the transient "you must know now"
   * surface; Details is the pointer to the "find it later" home. The host wires
   * this to `openSettings("about")`.
   */
  onDetails?: () => void;
}

export function UpdateNotice({
  state,
  version,
  currentVersion,
  error,
  dismissedVersion,
  announcement,
  release,
  onSkip,
  onUpdate,
  onRestart,
  onRetry,
  onClose,
  onDismissAnnouncement,
  onDetails,
}: UpdateNoticeProps) {
  const [sessionSkip, setSessionSkip] = useState<string | null>(null);

  if (announcement) {
    return (
      <AnnouncementCard
        announcement={announcement}
        onDismiss={() => onDismissAnnouncement?.(announcement.id)}
        onDetails={onDetails}
      />
    );
  }

  const dismissed = sessionSkip ?? dismissedVersion ?? null;
  if (!shouldShowUpdateNotice({ state, version, dismissedVersion: dismissed })) return null;

  const actions = updateNoticeActions(state);
  const busy = state === "installing";
  const securityUpdate = state === "available" && release?.security === true;
  const note = state === "available" && release ? summarizeRelease(release.body) : "";

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
      data-oc-update-security={securityUpdate ? "true" : undefined}
      className={`fixed left-3 right-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[55] flex w-auto max-h-[min(62vh,30rem)] flex-col gap-2 rounded-xl border bg-[var(--surface-float-base)] p-3 shadow-2xl duration-150 animate-in fade-in slide-in-from-bottom-2 sm:left-auto sm:right-4 sm:bottom-4 sm:w-[min(22rem,calc(100vw-2rem))] sm:max-h-[min(72vh,34rem)] ${
        securityUpdate ? "border-[var(--surface-critical-strong)]" : "border-[var(--border-base)]"
      }`}
    >
      <div className="flex min-h-0 items-start gap-2">
        <Icon state={state} security={securityUpdate} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <p className="text-xs font-medium text-[var(--text-strong)]">
            {securityUpdate ? "Security update" : "OpenCode update"}
          </p>
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
          {note && (
            <details data-oc-update-whats-new className="mt-1">
              <summary className="cursor-pointer text-[10px] text-[var(--text-weaker)] hover:text-[var(--text-weak)]">
                What's new
              </summary>
              <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--text-weak)]">
                {release?.title ? <p className="mb-1 font-medium text-[var(--text-strong)]">{release.title}</p> : null}
                {note}
              </div>
            </details>
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
          {onDetails && (
            <button
              type="button"
              data-oc-update-details
              onClick={onDetails}
              className="mr-auto cursor-pointer text-[11px] text-[var(--text-weaker)] underline-offset-2 transition-colors hover:text-[var(--text-strong)] hover:underline"
            >
              Details
            </button>
          )}
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

/**
 * The announcement variant of the notice card. Low-key for `info`, louder for
 * `warning`, loudest for `security` — and always dismissible.
 */
function AnnouncementCard({
  announcement,
  onDismiss,
  onDetails,
}: {
  announcement: WebuiAnnouncement;
  onDismiss: () => void;
  onDetails?: () => void;
}) {
  const { level } = announcement;
  const security = level === "security";
  const warning = level === "warning";
  const border = security
    ? "border-[var(--surface-critical-strong)]"
    : warning
      ? "border-[var(--surface-warning-strong,var(--border-base))]"
      : "border-[var(--border-base)]";
  const label = security ? "Security notice" : warning ? "Notice" : "Announcement";

  return (
    <div
      role="status"
      aria-live={security ? "assertive" : "polite"}
      data-oc-announcement
      data-oc-announcement-level={level}
      className={`fixed left-3 right-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[55] flex w-auto max-h-[min(62vh,30rem)] flex-col gap-2 rounded-xl border bg-[var(--surface-float-base)] p-3 shadow-2xl duration-150 animate-in fade-in slide-in-from-bottom-2 sm:left-auto sm:right-4 sm:bottom-4 sm:w-[min(24rem,calc(100vw-2rem))] sm:max-h-[min(72vh,34rem)] ${border}`}
    >
      <div className="flex min-h-0 items-start gap-2">
        <AnnouncementIcon level={level} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <p
            className={`text-xs font-medium ${
              security ? "text-[var(--surface-critical-strong)]" : "text-[var(--text-strong)]"
            }`}
          >
            {label}
          </p>
          <p className="mt-0.5 text-xs font-medium text-[var(--text-strong)]">{announcement.title}</p>
          {announcement.body ? (
            <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-weak)]">
              {announcement.body}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {onDetails && (
            <button
              type="button"
              data-oc-announcement-details
              onClick={onDetails}
              className="cursor-pointer text-[11px] text-[var(--text-weaker)] underline-offset-2 transition-colors hover:text-[var(--text-strong)] hover:underline"
            >
              Details
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            data-oc-announcement-dismiss
            title="Dismiss"
            aria-label="Dismiss announcement"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function AnnouncementIcon({ level }: { level: WebuiAnnouncement["level"] }) {
  if (level === "security") {
    return <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--surface-critical-strong)]" />;
  }
  if (level === "warning") {
    return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--text-interactive-base)]" />;
  }
  return <Megaphone className="mt-0.5 size-4 shrink-0 text-[var(--text-interactive-base)]" />;
}

function Icon({ state, security = false }: { state: UpdateNoticeState; security?: boolean }) {
  if (state === "installing") return <Spinner className="mt-0.5 size-4 shrink-0" />;
  if (state === "installed") return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--surface-success-strong)]" />;
  if (security) return <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--surface-critical-strong)]" />;
  return <ArrowUpCircle className="mt-0.5 size-4 shrink-0 text-[var(--text-interactive-base)]" />;
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "update.notice": (p) => <UpdateNotice {...(p as unknown as UpdateNoticeProps)} />,
});
