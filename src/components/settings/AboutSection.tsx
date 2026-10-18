import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Megaphone,
  RefreshCw,
  Rocket,
  ShieldAlert,
} from "lucide-react";
import {
  api,
  type WebuiAnnouncement,
  type WebuiConfig,
  type WebuiRelease,
} from "../../api/client";
import { autoRegister, Target } from "../../extensions/registry";
import { sortNewestFirst } from "../../lib/notices";
import { updateNoticeActions, updateNoticeMessage } from "../../lib/updateNotice";
import { checkForUpdate, checkNotices, installUpdate, restartUpdate, useStore } from "../../store";
import { Button } from "../ui/button";
import { Empty, ErrorNote, SectionHeader } from "./shared";

/**
 * Settings › About — the PERMANENT home for version / What's New /
 * announcements / usage data.
 *
 * The bottom-right `update.notice` card is the transient "you must know now"
 * surface; this page is the "find it later" home. Four blocks, top-to-bottom:
 *
 *  1. **Version + channel** — the running build (`GET /api/webui/config`) and
 *     the install channel (dev / binary / published) from the update probe.
 *  2. **Updates** — the live update status and the Check / Update / Restart
 *     actions, driven by the SAME R11 state machine the card uses
 *     (`store.updateNotice` + `store.updateCheck`; no second machine), plus an
 *     expandable **What's New** = the hub version feed, newest first.
 *  3. **Announcements** — the FULL live list from the hub feed (level badge,
 *     title, body, date), newest first, with an empty state. Deliberately
 *     **independent of card dismissal**: a user can dismiss the card and still
 *     find the announcement here.
 *  4. **Usage data** — the anonymous-usage opt-out (the `settings.telemetry`
 *     target, relocated here) with a one-line plain-language note, at the very
 *     bottom.
 *
 * The list leaves are their own targets so a tweak stays surgical. No new
 * state: everything reads the store; the config read is a one-shot catalog
 * fetch, matching the sidebar's version badge.
 *
 * Targets: `settings.about`, `settings.about.release`,
 * `settings.about.announcement`.
 */

/** One hub release note in the What's New changelog. */
function AboutReleaseEntry({ release }: { release: WebuiRelease }) {
  const body = (release.body ?? "").trim();
  const date = formatDate(release.published_at);
  return (
    <div
      data-oc-about-release
      data-oc-about-release-name={release.name}
      className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-[12px] font-medium text-[var(--text-strong)]">
          {release.name}
        </span>
        {release.title && release.title !== release.name && (
          <span className="text-[11px] text-[var(--text-weak)]">{release.title}</span>
        )}
        {release.security && (
          <span className="rounded-sm bg-[var(--surface-critical-weak)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--surface-critical-strong)]">
            security
          </span>
        )}
        {release.prerelease && (
          <span className="rounded-sm border border-[var(--border-weak-base)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--text-weaker)]">
            pre-release
          </span>
        )}
      </div>
      {body && (
        <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-weak)]">
          {body}
        </p>
      )}
      {date && <p className="mt-1 font-mono text-[10px] text-[var(--text-weaker)]">{date}</p>}
    </div>
  );
}

/** One hub announcement (full list row: level badge, title, body, date). */
function AboutAnnouncementEntry({ announcement }: { announcement: WebuiAnnouncement }) {
  const level = announcement.level;
  const date = formatDate(announcement.published_at);
  const badge =
    level === "security"
      ? "bg-[var(--surface-critical-weak)] text-[var(--surface-critical-strong)]"
      : level === "warning"
        ? "bg-[var(--surface-warning-weak)] text-[var(--surface-warning-strong)]"
        : "border border-[var(--border-weak-base)] text-[var(--text-weaker)]";
  const label = level === "security" ? "Security" : level === "warning" ? "Warning" : "Info";
  return (
    <div
      data-oc-about-announcement
      data-oc-about-announcement-level={level}
      className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-2.5"
    >
      <div className="flex items-start gap-2">
        <AnnouncementIcon level={level} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={`rounded-sm px-1 py-px font-mono text-[9px] uppercase tracking-wide ${badge}`}
            >
              {label}
            </span>
            <span className="text-[12px] font-medium text-[var(--text-strong)]">
              {announcement.title}
            </span>
          </div>
          {announcement.body && (
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-weak)]">
              {announcement.body}
            </p>
          )}
          {date && (
            <p className="mt-1 font-mono text-[10px] text-[var(--text-weaker)]">{date}</p>
          )}
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

const CHANNEL_LABEL: Record<string, string> = {
  dev: "Development checkout",
  binary: "Compiled binary",
  published: "Published release",
};

export function AboutSection() {
  const notices = useStore((s) => s.notices);
  const updateNotice = useStore((s) => s.updateNotice);
  const updateCheck = useStore((s) => s.updateCheck);
  const [config, setConfig] = useState<WebuiConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // One-shot build identity (version + dev tree hash), like the sidebar badge.
  useEffect(() => {
    let cancelled = false;
    api
      .webuiConfig()
      .then((c) => {
        if (!cancelled) {
          setConfig(c);
          setConfigError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setConfigError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opening the page refreshes the hub notices and (silently) the update probe,
  // so About is authoritative rather than whatever the boot pass happened to
  // catch. `silent` keeps a PASSIVE probe result (current / unavailable /
  // failed) from popping the transient card; a genuinely available update still
  // surfaces it — which is a real finding, not "Settings was opened".
  useEffect(() => {
    void checkNotices();
    void checkForUpdate({ silent: true });
  }, []);

  const announcements = sortNewestFirst(notices?.announcements ?? []);
  const releases = sortNewestFirst(notices?.versions ?? []);

  const version = config?.version ?? updateCheck?.current ?? updateNotice?.currentVersion ?? "…";
  const channel = updateCheck?.channel ?? updateNotice?.channel ?? null;
  const build = config?.build;
  const devBuild =
    channel === "dev" && build?.tree
      ? `${build.tree}${build.dirty ? " (dirty)" : ""}`
      : null;

  // Update status: the machine's message when it has one, otherwise the raw
  // probe (which survives a silent boot / a dismissed card).
  const checkState = updateNotice?.state;
  const installing = checkState === "installing";
  const installed = checkState === "installed";
  const failed = checkState === "failed";
  const available = updateCheck?.updateAvailable === true && Boolean(updateCheck.latest);

  let statusText: string;
  if (installing || installed || failed) {
    statusText = updateNoticeMessage(checkState, updateNotice?.version);
  } else if (updateCheck?.unavailable) {
    statusText = "Update checks are unavailable in this build.";
  } else if (available) {
    statusText = `Version ${updateCheck?.latest} is available.`;
  } else if (updateCheck) {
    statusText = updateNoticeMessage("current");
  } else {
    statusText = updateNoticeMessage("checking");
  }

  const actions = checkState ? updateNoticeActions(checkState) : [];
  const canUpdate = available && !installing && !installed && !failed;
  const canRestart = installed;
  const canRetry = failed || actions.includes("retry");

  return (
    <div data-oc-about className="space-y-4">
      <SectionHeader
        title="About this install"
        note="version · updates · announcements · usage data"
      />

      {/* 1 — version + channel */}
      <div
        data-oc-about-version
        className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-2"
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-[var(--text-strong)]">
              OpenCode Web UI
            </span>
            <span className="font-mono text-[13px] text-[var(--text-strong)]">{version}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">
            {channel ? (CHANNEL_LABEL[channel] ?? channel) : "Channel unknown"}
            {devBuild ? ` · ${devBuild}` : ""}
          </p>
        </div>
        {available ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-interactive-base)]">
            <ArrowUpCircle className="size-3.5" />
            update available
          </span>
        ) : updateCheck && !updateCheck.unavailable ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--surface-success-strong)]">
            <CheckCircle2 className="size-3.5" />
            up to date
          </span>
        ) : null}
      </div>

      {/* 2 — updates + What's New */}
      <div
        data-oc-about-updates
        className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-2.5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-strong)]">
              {installing ? <RefreshCw className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
              Updates
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">{statusText}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={installing}
              onClick={() => void checkForUpdate()}
            >
              <RefreshCw className={installing ? "animate-spin" : ""} />
              Check
            </Button>
            {canRetry && (
              <Button variant="outline" size="xs" onClick={() => void checkForUpdate()}>
                Retry
              </Button>
            )}
            {canUpdate && (
              <Button variant="default" size="xs" onClick={() => void installUpdate()}>
                <Rocket />
                Update
              </Button>
            )}
            {canRestart && (
              <Button variant="default" size="xs" onClick={() => void restartUpdate()}>
                <RefreshCw />
                Restart
              </Button>
            )}
          </div>
        </div>

        {failed && updateNotice?.error && (
          <p className="mt-2 break-words font-mono text-[10px] text-[var(--surface-critical-strong)]">
            {updateNotice.error}
          </p>
        )}

        <details data-oc-about-whats-new className="mt-2 border-t border-[var(--border-weak-base)] pt-2">
          <summary className="cursor-pointer text-[11px] text-[var(--text-weaker)] hover:text-[var(--text-weak)]">
            What&apos;s New
          </summary>
          <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
            {notices === null ? (
              <Empty>Loading…</Empty>
            ) : releases.length === 0 ? (
              <Empty>No release notes yet.</Empty>
            ) : (
              releases.map((release) => (
                <Target key={release.name} id="settings.about.release" release={release} />
              ))
            )}
          </div>
        </details>
      </div>

      {/* 3 — announcements (full live list; independent of card dismissal) */}
      <div
        data-oc-about-announcements
        className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-2.5"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-strong)]">
            <Megaphone className="size-3.5" />
            Announcements
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Refresh announcements"
            onClick={() => void checkNotices()}
          >
            <RefreshCw />
          </Button>
        </div>
        {notices === null ? (
          <Empty>Loading…</Empty>
        ) : announcements.length === 0 ? (
          <Empty>No announcements right now.</Empty>
        ) : (
          <div className="space-y-2">
            {announcements.map((announcement) => (
              <Target
                key={announcement.id}
                id="settings.about.announcement"
                announcement={announcement}
              />
            ))}
          </div>
        )}
      </div>

      {/* 4 — usage data (the relocated telemetry opt-out), at the very bottom */}
      <div data-oc-about-usage>
        <SectionHeader title="Usage data" note="anonymous — opt out any time" />
        <p className="mb-2 text-[11px] leading-relaxed text-[var(--text-weaker)]">
          A coarse heartbeat that never identifies you or the work you do here — turn it off
          below and nothing is sent.
        </p>
        <Target id="settings.telemetry" heading={false} />
      </div>

      {configError && <ErrorNote message={`Build info unavailable: ${configError}`} />}
    </div>
  );
}

/** `2026-10-16T00:00:00Z` → `Oct 16, 2026`; "" for a missing/invalid input. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "settings.about": () => <AboutSection />,
  "settings.about.release": (p) => <AboutReleaseEntry release={p.release as WebuiRelease} />,
  "settings.about.announcement": (p) => (
    <AboutAnnouncementEntry announcement={p.announcement as WebuiAnnouncement} />
  ),
});
