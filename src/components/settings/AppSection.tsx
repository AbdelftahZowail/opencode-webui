import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "../ui/button";
import { SectionHeader } from "./shared";
import {
  consumeInstallPrompt,
  getInstallPrompt,
  isStandalone,
  notificationPermission,
  onInstallAvailable,
  setTileEnabled,
  swSupported,
  tileEnabled,
} from "../../lib/pwa";
import {
  STREAM_MODES,
  STREAM_MODE_DESC,
  STREAM_MODE_SHORT,
  getPrefs,
  setPref,
  subscribePrefs,
  type StreamMode,
} from "../../prefs";

export function AppSection() {
  const [, bump] = useState(0);
  const [tileOn, setTileOn] = useState(() => tileEnabled());
  const [perm, setPerm] = useState(() => notificationPermission());
  const [installable, setInstallable] = useState(false);
  const [streamMode, setStreamMode] = useState<StreamMode>(() => getPrefs().streamMode);

  useEffect(() => subscribePrefs(() => setStreamMode(getPrefs().streamMode)), []);

  useEffect(() => {
    setInstallable(getInstallPrompt() !== null);
    return onInstallAvailable(() => {
      setInstallable(getInstallPrompt() !== null);
      bump((v) => v + 1);
    });
  }, []);

  const supported = swSupported();
  const standalone = isStandalone();

  const requestInstall = async () => {
    const prompt = consumeInstallPrompt();
    const ev = prompt as unknown as { prompt?: () => Promise<void> } | null;
    try {
      await ev?.prompt?.();
    } catch {
      /* user dismissed — the event re-fires next visit */
    }
    setInstallable(false);
  };

  const enableTile = async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setPerm(result);
    if (result === "granted") {
      setTileEnabled(true);
      setTileOn(true);
    }
  };

  const toggleTile = () => {
    const next = !tileOn;
    setTileEnabled(next);
    setTileOn(next);
  };

  return (
    <div className="space-y-4">
      <div>
        <SectionHeader title="Install" note="Run the UI as a standalone app" />
        {!supported ? (
          <p className="text-xs text-[var(--text-weaker)]">
            Install needs a secure context — serve over HTTPS (e.g. Tailscale) or localhost. Plain-LAN
            HTTP stays a browser tab.
          </p>
        ) : standalone ? (
          <p className="text-xs text-[var(--text-base)]">Installed — running standalone.</p>
        ) : installable ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--text-weaker)]">Ready to install on this device.</p>
            <Button onClick={requestInstall}>Install app</Button>
          </div>
        ) : (
          <p className="text-xs text-[var(--text-weaker)]">
            Use the browser menu → “Add to Home screen” / “Install”. Chrome offers it automatically once
            the app has been visited.
          </p>
        )}
      </div>

      <div>
        <SectionHeader
          title="Response streaming"
          note="How often the transcript repaints while a run streams"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--text-weaker)]">{STREAM_MODE_DESC[streamMode]}</p>
          <div role="radiogroup" aria-label="Response streaming" className="flex shrink-0 gap-1">
            {STREAM_MODES.map((mode) => (
              <Button
                key={mode}
                size="xs"
                variant={streamMode === mode ? "secondary" : "ghost"}
                aria-pressed={streamMode === mode}
                onClick={() => setPref("streamMode", mode)}
              >
                {STREAM_MODE_SHORT[mode]}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <SectionHeader title="Live activity tile" note="Silent notification while agents run" />
        {perm === "unsupported" ? (
          <p className="text-xs text-[var(--text-weaker)]">
            Notifications aren’t available here — secure context required.
          </p>
        ) : perm !== "granted" ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--text-weaker)]">
              One quiet notification shows what’s running; tapping it opens that session. No buzz, clears
              itself when idle.
            </p>
            <Button onClick={enableTile}>
              <Bell />
              Enable
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--text-weaker)]">
              {tileOn ? "On — tile follows active sessions." : "Off — no tile will be shown."}
            </p>
            <Button variant={tileOn ? "ghost" : undefined} onClick={toggleTile}>
              {tileOn ? "Turn off" : "Turn on"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
