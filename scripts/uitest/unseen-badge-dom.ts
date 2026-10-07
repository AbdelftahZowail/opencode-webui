#!/usr/bin/env bun
/**
 * Unread ("new") badge DOM check — the real row markup in real Chrome.
 *
 *   bun run scripts/uitest/unseen-badge-dom.ts
 *
 * The badge is a Radix Tooltip nested INSIDE the session row's <a> — exactly
 * the shape that breaks tooltip libraries (trigger rendered as a <button> in
 * an anchor). This renders the REAL `SessionUnseenBadge` inside a real row
 * anchor under a real `TooltipProvider` and asserts in a headless browser
 * that it mounts clean, opens its explanation on hover, and carries the
 * contract anchor + the one-shot arrival animation.
 *
 * Test-only file: writes a scratch fixture, touches neither src/ nor server/.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildEntryBundle, sleep, withDomPage, type DomSession } from "./dom-harness";

const REPO = join(import.meta.dir, "..", "..");
// The entry must live INSIDE the repo: Bun.build resolves `react` / `react-dom`
// by walking up from the entry, and a /tmp fixture has no node_modules above it.
const scratch = mkdtempSync(join(REPO, ".uitest-unseen-dom-"));

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const entryPath = join(scratch, "entry.tsx");

// The REAL built stylesheet, so the arrival animation and the badge's own
// utility classes are verified as shipped — not as a hand-copied stub. Requires
// a prior `bun run build` (which the release gate runs anyway).
const cssFiles = [...new Bun.Glob("dist/assets/index-*.css").scanSync(REPO)];
if (cssFiles.length === 0) {
  console.error("FAIL dist CSS not found — run `bun run build` before this check");
  process.exit(1);
}
const css = await Bun.file(cssFiles.sort().at(-1)!).text();

// Mirrors the real sidebar row: the badge sits INSIDE the row anchor. If the
// tooltip trigger rendered a <button>, the browser would autoclose the <a>
// and the nested-interactive assertion below would fail.
await Bun.write(
  entryPath,
  `
import { createRoot } from "react-dom/client";
import { TooltipProvider } from ${JSON.stringify(join(REPO, "src/components/ui/tooltip.tsx"))};
import { SessionUnseenBadge } from ${JSON.stringify(join(REPO, "src/components/SessionUnseenBadge.tsx"))};

const ago = Date.now() - 5 * 60_000;
createRoot(document.getElementById("root")).render(
  <TooltipProvider>
    <div style={{ padding: 24, background: "#111", color: "#eee", width: 288 }}>
      <a
        href="/session/ses_1"
        title="Audit the auth flow"
        style={{ display: "block", padding: "8px 10px", borderRadius: 6, textDecoration: "none", color: "inherit" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, font: "500 13px system-ui" }}>Audit the auth flow</span>
          <SessionUnseenBadge updated={ago} />
        </div>
        <div style={{ marginTop: 2, font: "11px ui-monospace", color: "#888" }}>ses_0123456789ab · 5m</div>
      </a>
    </div>
  </TooltipProvider>
);
window.__ready = true;
`,
);

await Bun.write(
  join(scratch, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>unseen badge</title><style>${css}</style></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
);
// Chrome asks for /favicon.ico on every navigation, and the real stylesheet
// pulls /assets/*.woff2 — copy both in so the fixture produces no 404 noise
// that would mask a real error.
await Bun.write(join(scratch, "favicon.ico"), new Uint8Array(0));
await mkdirSync(join(scratch, "assets"), { recursive: true });
for (const font of ["Inter.ttf", "JetBrainsMonoNerdFontMono-Regular.woff2", "opencode.svg"]) {
  const src = join(REPO, "dist", "assets", font);
  if (await Bun.file(src).exists()) await Bun.write(join(scratch, "assets", font), Bun.file(src));
}
await buildEntryBundle(entryPath, join(scratch, "entry.js"));

try {
  await withDomPage(scratch, async ({ cdp, baseUrl }: DomSession) => {
    await cdp.call("Runtime.enable");
    await cdp.call("Log.enable");
    await cdp.call("Network.enable");
    await cdp.goto(baseUrl);

    const ready = await cdp.waitFor("window.__ready === true", { timeoutMs: 15_000 });
    check("fixture booted", ready.ok === true, String((ready as { last?: unknown }).last));

    // --- 1. mounts clean -------------------------------------------------
    const rendered = (await cdp.evaluate(
      `(() => {
         const b = document.querySelector('[data-oc-session-unseen]');
         return JSON.stringify({ html: document.getElementById('root').innerHTML, tag: b ? b.tagName : '' });
       })()`,
    )) as string;
    const { html, tag } = JSON.parse(rendered || '{"html":"","tag":""}') as { html: string; tag: string };

    check("badge mounts", tag === "SPAN", `tag=${tag}`);
    check("badge carries the contract anchor", html.includes('data-oc-session-unseen="true"'));
    check('badge shows the word "new"', />new</.test(html));
    check(
      "no interactive element nested inside the row anchor (valid markup)",
      !/<a[^>]*>[\s\S]{0,400}?<(a|button|input|select|textarea)\b/i.test(html),
      "nested interactive element inside the <a>",
    );
    check("no console errors / exceptions on mount", cdp.consoleLines.length === 0, cdp.consoleTail(3));

    // --- 2. the arrival animation is wired and running -------------------
    const anim = JSON.parse(
      (await cdp.evaluate(
        `(() => { const b = document.querySelector('[data-oc-session-unseen]'); const s = getComputedStyle(b);
           return JSON.stringify({ cls: b.className, dur: s.animationDuration, name: s.animationName }); })()`,
      )) as string,
    ) as { cls: string; dur: string; name: string };
    check("badge has the arrival animation class", anim.cls.includes("session-unseen"), anim.cls);
    check("arrival animation actually runs", anim.dur !== "0s" && anim.name !== "none", `${anim.name} ${anim.dur}`);

    // --- 3. the explanation opens on hover -------------------------------
    // Radix opens on pointermove (and ignores touch pointers), so dispatch
    // exactly what a real mouse would send.
    await cdp.evaluate(
      `(() => { const b = document.querySelector('[data-oc-session-unseen]');
         b.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
         return 1; })()`,
    );
    let tip = "";
    for (let i = 0; i < 50 && !tip; i++) {
      tip = (await cdp.evaluate(
        `(document.querySelector('[data-slot="tooltip-content"]')?.textContent) || ""`,
      )) as string;
      if (!tip) await sleep(100);
    }
    check("explanation opens on hover", tip.length > 0, "no tooltip content appeared");
    check("it says the output is unread", /unread/i.test(tip), tip.slice(0, 90));
    check("it states the age", /5m ago/.test(tip), tip.slice(0, 90));
    check("it explains how to clear it", /clears/i.test(tip) && /any tab/i.test(tip), tip.slice(0, 140));

    const sr = (await cdp.evaluate(`(document.querySelector('.sr-only')?.textContent) || ""`)) as string;
    check("screen readers are told the state too", /unread/i.test(sr), sr.slice(0, 90));

    check("no fixture asset 404s", !cdp.consoleLines.some((l) => /404/.test(l)), cdp.consoleTail(3));
    check("still no console errors after interaction", cdp.consoleLines.length === 0, cdp.consoleTail(3));
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nRESULT: ${passed} pass · ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
