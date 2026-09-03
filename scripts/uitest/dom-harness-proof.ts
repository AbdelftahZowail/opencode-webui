#!/usr/bin/env bun
/**
 * dom-harness proof (R-T1 acceptance): two rich-render assertions (rr-cdp
 * T1+T2) ported onto `scripts/uitest/dom-harness.ts` with zero hand-rolled
 * CDP/chrome/fixture-server code in this file.
 *
 *   bun scripts/uitest/dom-harness-proof.ts
 *
 * Proves: fixture serving + dom-bundle build + headless-chrome evaluate +
 * settled-wait all work through the harness against the REAL
 * webui-extensions/rich-render/dom.ts + REAL src/lib/domKit.ts.
 *
 * Own ports/scratch only (/tmp/opencode/dom-proof-<pid>); everything torn
 * down in `finally`. Test-only file: modifies neither src/ nor server/.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDomBundle,
  Cdp,
  connectPage,
  freePort,
  launchChrome,
  serveFixtureDir,
  sleep,
  waitSettled,
} from "./dom-harness";

const ROOT = join(import.meta.dir, "..", "..");
const SCRATCH = `/tmp/opencode/dom-proof-${process.pid}`;

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>dom-harness proof fixture</title></head>
<body>
<div data-oc-transcript>
  <div id="row1" data-oc-message data-oc-message-id="m1" data-oc-message-type="assistant">
    <div class="md">
      <pre><code class="language-js">const x = 1;
</code></pre>
      <pre><code class="language-html">&lt;div&gt;hi&lt;/div&gt;
</code></pre>
    </div>
  </div>
  <div id="live-region">
    <pre><code class="language-html">&lt;b&gt;streaming&lt;/b&gt;
</code></pre>
  </div>
</div>
<script type="module">
  import "/proof-bundle.js";
  window.__proofErrors = [];
  window.addEventListener("error", (e) => window.__proofErrors.push("error: " + e.message));
  window.addEventListener("unhandledrejection", (e) => window.__proofErrors.push("rejection: " + String(e.reason)));
  window.__proof.mount();
</script>
</body></html>
`;

interface Row {
  label: string;
  status: "PASS" | "FAIL";
  detail: string;
}
const rows: Row[] = [];

async function main(): Promise<void> {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, "proof-fixture.html"), FIXTURE_HTML);
  await buildDomBundle(
    {
      extId: "rich-render",
      domPath: join(ROOT, "webui-extensions", "rich-render", "dom.ts"),
      entryPath: join(SCRATCH, "proof-entry.ts"),
      globalName: "__proof",
    },
    join(SCRATCH, "proof-bundle.js"),
  );

  const server = serveFixtureDir(SCRATCH);
  const chrome = launchChrome({ debugPort: freePort() });
  let cdp: Cdp | null = null;
  try {
    cdp = new Cdp(await connectPage(chrome.debugPort));
    await cdp.open();
    await cdp.goto(server.url("/proof-fixture.html"));

    // Mounts happen after the settle gate (two identical reads over quiet
    // windows) — waitSettled is the harness-side analog: true on consecutive
    // reads, so the assertion below never races a mid-stream DOM.
    const settled = await waitSettled(
      cdp,
      `(() => !!document.querySelector('#row1 .rr-live'))()`,
      { timeoutMs: 15_000, intervalMs: 300, stableReads: 2 },
    );
    if (!settled.ok) {
      rows.push({
        label: "SETUP live mount settled",
        status: "FAIL",
        detail: `rr-live never stabilized: ${String(settled.last).slice(0, 200)} console: ${cdp.consoleTail(4)}`,
      });
      return;
    }

    // T1 (ported from rr-cdp): backtick ```js stays code.
    {
      const r = (await cdp.evaluate(`(() => {
        const pre = document.querySelector('#row1 code.language-js')?.closest('pre');
        if (!pre) return 'no-pre';
        const sib = pre.nextElementSibling;
        return JSON.stringify({ hidden: pre.classList.contains('rr-hidden'),
          nextIsLive: !!(sib && sib.classList.contains('rr-live')) });
      })()`)) as string;
      const j = JSON.parse(r) as { hidden: boolean; nextIsLive: boolean };
      rows.push({
        label: "T1 backtick ```js stays code",
        status: !j.hidden && !j.nextIsLive ? "PASS" : "FAIL",
        detail: r,
      });
    }

    // T2 (ported from rr-cdp): ~~~html mounts a sandboxed live frame.
    {
      const r = (await cdp.evaluate(`(() => {
        const pre = document.querySelector('#row1 code.language-html')?.closest('pre');
        const wrap = pre?.nextElementSibling;
        const f = wrap?.querySelector('iframe');
        return JSON.stringify({ hidden: pre?.classList.contains('rr-hidden'),
          wrapLive: wrap?.classList.contains('rr-live'),
          sandbox: f?.getAttribute('sandbox'),
          allowSameOrigin: (f?.getAttribute('sandbox') ?? '').includes('allow-same-origin'),
          srcdocHasCSP: (f?.getAttribute('srcdoc') ?? '').includes('Content-Security-Policy'),
          srcdocHasContent: (f?.getAttribute('srcdoc') ?? '').includes('<div>hi</div>'),
          badge: wrap?.querySelector('.rr-live-badge')?.textContent?.trim() });
      })()`)) as string;
      const j = JSON.parse(r) as Record<string, unknown>;
      const ok =
        j.hidden === true &&
        j.wrapLive === true &&
        j.sandbox === "allow-scripts" &&
        j.allowSameOrigin === false &&
        j.srcdocHasCSP === true &&
        j.srcdocHasContent === true &&
        String(j.badge).includes("HTML") &&
        String(j.badge).includes("LIVE");
      rows.push({ label: "T2 ~~~html sandboxed live mount", status: ok ? "PASS" : "FAIL", detail: r });
    }
  } finally {
    cdp?.close();
    await chrome.kill();
    server.stop();
    rmSync(SCRATCH, { recursive: true, force: true });
  }
}

let code = 0;
try {
  await main();
} catch (err) {
  rows.push({
    label: "SETUP (fatal)",
    status: "FAIL",
    detail: (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 1_500),
  });
  code = 1;
}
await sleep(50);
const width = Math.max(...rows.map((r) => r.label.length), 20);
console.log("\n=== dom-harness proof (rr T1+T2 via harness) ===");
for (const r of rows) {
  console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}`);
  console.log(`     ${r.detail.slice(0, 400)}`);
}
const pass = rows.filter((r) => r.status === "PASS").length;
const fail = rows.filter((r) => r.status === "FAIL").length;
console.log(`\nRESULT: ${pass} pass · ${fail} fail → exit ${fail > 0 ? 1 : 0}`);
process.exit(fail > 0 ? 1 : code);
