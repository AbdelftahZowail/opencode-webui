import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Switch } from "../ui/switch";
import { SectionHeader } from "./shared";
import {
  attentionConfig,
  setAttentionConfig,
  subscribeAttention,
  type AttentionConfig,
} from "../../lib/attention";

/**
 * Settings › Notifications (R5). Binds the `attention` config in the prefs
 * store (see `lib/attention.ts`): a master switch gating every attention cue,
 * sub-switches for OS notifications and the synthesized sound, and a volume
 * slider. Mirrors AppSection's shape — a plain tab body, no self-registration.
 *
 * Enabling OS notifications requires the browser permission: the switch only
 * turns on (and `enabled` only persists) once `Notification.requestPermission`
 * reports "granted".
 */
export function NotificationsSection() {
  const [cfg, setCfg] = useState<AttentionConfig>(() => attentionConfig());
  useEffect(() => subscribeAttention(() => setCfg(attentionConfig())), []);

  const supported = typeof Notification !== "undefined";
  const permission = supported ? Notification.permission : "unsupported";

  /** Master switch: request permission (when notifications are on) before enabling. */
  const toggleEnabled = async (next: boolean) => {
    if (!next) {
      setAttentionConfig({ enabled: false });
      return;
    }
    if (supported && cfg.notifications) {
      const result = await Notification.requestPermission();
      // Only persist enabled:true once permission is granted.
      if (result !== "granted") return;
    }
    setAttentionConfig({ enabled: true });
  };

  /** Notifications switch: only turn on with granted permission. */
  const toggleNotifications = async (next: boolean) => {
    if (!next) {
      setAttentionConfig({ notifications: false });
      return;
    }
    if (supported) {
      const result = await Notification.requestPermission();
      if (result !== "granted") return;
    }
    setAttentionConfig({ notifications: true });
  };

  const rowCls = "flex items-center justify-between gap-3";
  const subCls = cfg.enabled ? "" : "pointer-events-none opacity-50";

  return (
    <div data-oc-attention-section className="space-y-4">
      <div>
        <SectionHeader
          title="Attention"
          note="Notify and play a cue when a run finishes or needs you"
        />
        <div className={rowCls}>
          <div className="min-w-0">
            <div className="text-[13px] text-[var(--text-strong)]">Enable attention</div>
            <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">
              {cfg.enabled
                ? "On — cues fire for finished turns, errors, permissions and questions."
                : "Off — nothing fires until you enable this."}
            </p>
          </div>
          <Switch checked={cfg.enabled} title="Enable attention" onCheckedChange={(v) => void toggleEnabled(v)} />
        </div>
      </div>

      <div className={`space-y-3 ${subCls}`}>
        <div className={rowCls}>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] text-[var(--text-strong)]">
              <Bell className="size-3.5" />
              OS notifications
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">
              {!supported
                ? "Not available here — secure context required."
                : permission === "granted"
                  ? "Shown while the tab is hidden (subagents stay quiet)."
                  : permission === "denied"
                    ? "Blocked by the browser — allow notifications in site settings."
                    : "Turns on once you grant the browser permission."}
            </p>
          </div>
          <Switch
            checked={cfg.notifications}
            disabled={!supported}
            title="OS notifications"
            onCheckedChange={(v) => void toggleNotifications(v)}
          />
        </div>

        <div className={rowCls}>
          <div className="min-w-0">
            <div className="text-[13px] text-[var(--text-strong)]">Sound</div>
            <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">
              A short synthesized cue per event.
            </p>
          </div>
          <Switch
            checked={cfg.sound}
            title="Sound"
            onCheckedChange={(v) => setAttentionConfig({ sound: v })}
          />
        </div>

        <div className={rowCls}>
          <div className="min-w-0">
            <div className="text-[13px] text-[var(--text-strong)]">Volume</div>
            <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">
              {Math.round(cfg.volume * 100)}%
            </p>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={cfg.volume}
            disabled={!cfg.sound}
            aria-label="Attention sound volume"
            onChange={(e) => setAttentionConfig({ volume: Number(e.target.value) })}
            className="w-40 accent-[var(--text-interactive-base)] disabled:opacity-50"
          />
        </div>
      </div>
    </div>
  );
}
