/**
 * testkit-echo — DOM stratum (fixture).
 *
 * Injects exactly one visible marker element (`[data-testkit-echo]`) and one
 * scoped style. This is the real-browser, user-visible effect the harness's
 * Playwright driver asserts against the LIVE app page.
 *
 * `DomKit` is a type-only import: it is erased at build time, so the bundle
 * stays standalone (no core import survives into the served `dom.js`) — the
 * same property every external DOM extension relies on.
 */

import type { DomKit } from "../../../../src/lib/domKit";

const MARKER_ATTR = "data-testkit-echo";
const MARKER_TEXT = "TESTKIT_ECHO_UI";

export default {
  mount(kit: DomKit): () => void {
    const marker = document.createElement("div");
    marker.setAttribute(MARKER_ATTR, "1");
    marker.textContent = MARKER_TEXT;
    marker.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:2147483647;" +
      "padding:4px 8px;border-radius:6px;background:#111827;color:#fff;" +
      "font:12px/1.4 system-ui,sans-serif";
    document.body.appendChild(marker);

    const unstyle = kit.styles(`[${MARKER_ATTR}]{pointer-events:none}`);

    return () => {
      unstyle();
      marker.remove();
    };
  },
  dispose(): void {
    document.querySelector(`[${MARKER_ATTR}]`)?.remove();
  },
};
