/**
 * rich-render — browser stratum (settings contribution only).
 *
 * The rendering itself lives in dom.ts (post-render sibling injection next
 * to markdown code blocks — the React tree has no markdown/code-block
 * target to wrap, and adding one would freeze core's Markdown for no gain).
 * This module owns the one browser-stratum job: a Settings › Extensions
 * toggle so the user can pause live rendering without uninstalling.
 *
 * PORTABILITY: this file imports NOTHING from src/ at runtime — only the
 * `window.__opencodeUI` bridge (typed via a type-only import, erased at
 * bundle) and bare "react" (external, resolved by the page import map).
 * A src/ runtime import works for shipped copies (same Vite build) but
 * breaks user/project-dir copies (the proxy bundles the folder standalone
 * and ../../src/... doesn't exist there), so the folder would load in one
 * source and vanish in another. Same-id shadowing must keep working.
 *
 * Contract notes:
 * - One register() call under this id (same-id re-register swaps).
 * - The pref lives in localStorage under "rich-render.enabled" ("0" = off,
 *   anything else = on) and is broadcast on window as "rich-render:prefs"
 *   so dom.ts re-evaluates without a reload. Install gating stays owned by
 *   the folder itself (presence / manifest disabled) — this pref only
 *   pauses the live frames, it never unregisters anything.
 */
import { useEffect, useState } from "react";
import type { ExtensionApi } from "../../src/lib/extensionApi";

export const id = "rich-render";

const ext: ExtensionApi = window.__opencodeUI;

export const PREF_KEY = "rich-render.enabled";
export const PREF_EVENT = "rich-render:prefs";

export function isRichRenderEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

function RichRenderSettings() {
  const [enabled, setEnabled] = useState<boolean>(isRichRenderEnabled);
  useEffect(() => {
    const refresh = () => setEnabled(isRichRenderEnabled());
    window.addEventListener(PREF_EVENT, refresh);
    return () => window.removeEventListener(PREF_EVENT, refresh);
  }, []);
  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    try {
      window.localStorage.setItem(PREF_KEY, next ? "1" : "0");
    } catch {
      /* pref persistence is best-effort; the broadcast still applies */
    }
    window.dispatchEvent(new CustomEvent(PREF_EVENT));
  };
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[var(--text-base)]">
      <input
        type="checkbox"
        checked={enabled}
        onChange={toggle}
        className="mt-1 size-3.5 shrink-0 cursor-pointer accent-[var(--surface-brand-base)]"
      />
      <span>
        <span className="block font-medium text-[var(--text-strong)]">Live inline previews</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-weak)]">
          Render ~~~html / ~~~svg / ~~~pdf / ~~~image fences as isolated live output with a
          code toggle. Backtick (```) fences always stay code. Off restores stock rendering
          without uninstalling.
        </span>
      </span>
    </label>
  );
}

ext.register({
  kind: "contribute",
  id: "rich-render",
  collection: "settings",
  item: {
    title: "Rich render",
    description: "Inline live previews for tilde-fenced HTML, SVG, PDF and image blocks",
    render: () => <RichRenderSettings />,
  },
});

// Self-accept so edits hot-swap: same-id registry swap, no reload.
if (import.meta.hot) import.meta.hot.accept();
