import { useEffect, useState } from "react";
import { Switch } from "../ui/switch";
import { SectionHeader } from "./shared";
import { getPrefs, setPref, subscribePrefs } from "../../prefs";

/**
 * Settings › Security — how agent permission requests are shown (parity R12).
 *
 * One pref-backed toggle: render a permission prompt as a full-viewport
 * overlay instead of the docked composer slot. Bound to the persisted
 * `permissionFullscreen` pref (see `src/prefs.ts`) and re-synced live, so
 * flipping it here repaints an open `PendingRequestsPanel` immediately. The
 * per-request `ctrl/⌘+f` binding in that panel overrides this default without
 * changing it.
 *
 * Kept as its own file/section (not folded into `AccessSection`) so it stays
 * visible even when the serve-config API is unavailable — `AccessSection`
 * early-returns on load error.
 */
export function PermissionSection() {
  const [fullscreen, setFullscreen] = useState(() => getPrefs().permissionFullscreen);
  useEffect(() => subscribePrefs(() => setFullscreen(getPrefs().permissionFullscreen)), []);

  return (
    <div data-oc-permission-settings className="space-y-4">
      <SectionHeader title="Permission prompts" note="how agent permission requests are shown" />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] text-[var(--text-strong)]">Permission prompts full-screen</div>
          <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">
            Show permission requests in a full-screen overlay by default (ctrl+f on a request toggles it).
          </p>
        </div>
        <Switch
          checked={fullscreen}
          title="Permission prompts full-screen"
          onCheckedChange={(checked) => setPref("permissionFullscreen", checked)}
        />
      </div>
    </div>
  );
}
