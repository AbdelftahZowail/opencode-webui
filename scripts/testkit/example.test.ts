#!/usr/bin/env bun
/**
 * TESTKIT worked example — how to test a plugin/webui extension like a user.
 *
 *   bun run testkit:example
 *
 * Boots a FULLY ISOLATED OpenCode v2 engine + opencode-webui proxy, installs
 * `fixtures/testkit-echo` (engine tool + proxy route + browser bundle + DOM
 * marker), then drives the system with the REAL CLIENTS the user actually
 * uses — a real Chromium page (the environment's browser; OPTIONAL and never
 * bundled — browser checks skip cleanly without one) and the real `opencode`
 * TUI in a real tmux terminal — capturing rendered output as evidence. The TUI
 * text grid is the primary assertion and needs no browser.
 *
 * Evidence vs claim (per the project's testing rule):
 *   - EVIDENCE = what a real client RENDERED (DOM text, terminal buffer,
 *     screenshots saved under the artifacts dir). An agent whose model can
 *     read images can open the PNGs directly.
 *   - CLAIM    = an API/HTTP response. Used only as a cross-check or to set up
 *     state a headless client cannot create — never the sole proof.
 *
 * The TUI has TWO representations: the text grid (`tmux capture-pane -p`) is the
 * ASSERTION SUBSTRATE — deterministic, agent-optimized; `renderPng()` adds an
 * illustrative human-facing PNG (xterm.js in headless Chromium), never a pixel
 * contract.
 *
 * Model-dependent steps are GATED: the isolated instance ships no provider
 * credentials, so a real model turn is opt-in via `TESTKIT_MODEL` (+
 * `TESTKIT_PROVIDER_CREDS=1`); otherwise the example SKIPs it and says so.
 *
 * Test-only file: modifies neither src/ nor server/.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Reporter, expect, liveServiceFingerprint, start, type TestkitHandle } from "./harness";

const FIXTURE = join(import.meta.dir, "fixtures", "testkit-echo");
const EXT_ID = "testkit-echo";

/** Port of the developer's live engine, for the isolation comparison. */
function liveEnginePort(servicePath: string): number | null {
  try {
    const raw = readFileSync(servicePath, "utf8");
    const url = (JSON.parse(raw) as { url?: string }).url;
    return url ? Number(new URL(url).port) : null;
  } catch {
    return null;
  }
}

const rep = new Reporter();
let h: TestkitHandle | null = null;

// --- isolation proof: fingerprint the live registration file BEFORE boot ---
const liveBefore = liveServiceFingerprint();
const livePort = liveEnginePort(liveBefore.path);

try {
  h = await start({ extensions: [FIXTURE], model: process.env.TESTKIT_MODEL, providerCreds: process.env.TESTKIT_PROVIDER_CREDS === "1" });
  rep.onFailure(() => {
    void h?.dumpArtifacts();
  });

  console.log("\n--- testkit instance ---");
  console.log(`scratch   : ${h.paths.root}`);
  console.log(`engine    : ${h.engine.url} (pid ${h.engine.pid})`);
  console.log(`proxy     : ${h.proxy.url} (pid ${h.proxy.pid})`);
  console.log(`ext dir   : ${h.paths.extensions}`);
  console.log(`artifacts : ${h.paths.artifacts}`);
  console.log(`live srv  : ${liveBefore.path} (port ${livePort ?? "n/a"})`);
  console.log(
    `browser   : ${h.browser.available ? `${h.browser.source} (${h.browser.executablePath})` : `none — ${h.browser.reason}`}`,
  );

  // -------------------------------------------------------------------------
  await rep.check("isolation — own ports/dirs; the live service.json is untouched", async () => {
    const after = liveServiceFingerprint();
    expect(after.path).toBe(liveBefore.path);
    expect(after.mtimeMs).toBe(liveBefore.mtimeMs); // never written
    expect(after.ino).toBe(liveBefore.ino);
    expect(h!.paths.root).toContain("tk-"); // a throwaway scratch dir, not the real state
    expect(existsSync(h!.paths.root)).toBe(true);
    expect(h!.engine.port === livePort).toBe(false); // never collides with the live engine
    expect(existsSync(join(h!.paths.state, "opencode", "service.json"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Strata live. These are CLAIM-level (HTTP); the real-client evidence below
  // is what actually proves the extension is working for a user.
  // -------------------------------------------------------------------------
  await rep.check("install — all four strata are live (CLAIM: HTTP)", async () => {
    const manifest = await h!.client.extensionManifest();
    const entry = manifest.find((e) => e.id === EXT_ID) as { url?: string; domUrl?: string } | undefined;
    expect(Boolean(entry), "manifest lists the extension").toBe(true);
    expect(Boolean(entry?.url), "browser bundle url present").toBe(true);
    expect(Boolean(entry?.domUrl), "dom bundle url present").toBe(true);

    const route = await h!.client.extJSON<{ marker?: string }>(EXT_ID, "echo");
    expect(route.marker).toBe("TESTKIT_ECHO_PROXY");

    // Proxy-stratum KV round-trip (ctx.kv through an extension route).
    const key = `k_${Date.now().toString(36)}`;
    await h!.client.extPost(EXT_ID, "kv", { key, value: "hello-kv" });
    const kv = await h!.client.extJSON<{ data?: Record<string, unknown> }>(EXT_ID, "kv");
    expect(kv.data?.[key]).toBe("hello-kv");

    // Proxy-stratum event tap (always-on, no browser attached). It is wired if
    // the route answers; it only counts once engine activity produces events
    // (asserted > 0 after the user turn below).
    const tap = await h!.client.extJSON<{ count: number }>(EXT_ID, "events");
    expect(typeof tap.count, "event tap route responds with a count").toBe("number");

    const plugins = await h!.client.plugins();
    const plugin = plugins.find((p) => (p as { id?: string }).id === EXT_ID) as { state?: { status?: string } } | undefined;
    expect(plugin?.state?.status).toBe("active");
  });

  // -------------------------------------------------------------------------
  // REAL CLIENT 1 — the webui page in a real Chromium. The browser is OPTIONAL
  // and never bundled: with none, these checks SKIP and the run continues.
  // -------------------------------------------------------------------------
  const WEBUI_MARKER_CHECK = "webui — real page renders the extension's DOM marker (EVIDENCE)";
  const WEBUI_TURN_CHECK = "webui — create session + type + send renders the user's turn (EVIDENCE: real user path)";
  if (!h.browser.available) {
    rep.skip(WEBUI_MARKER_CHECK, `${h.browser.reason} — install a browser or set CHROME_PATH to run it`);
    rep.skip(WEBUI_TURN_CHECK, `${h.browser.reason} — install a browser or set CHROME_PATH to run it`);
  } else {
    await rep.check(WEBUI_MARKER_CHECK, async () => {
      await h!.ui.goto("/");
      await h!.ui.waitFor(`document.body.innerText.includes("TESTKIT_ECHO_UI")`, { timeoutMs: 30_000 });
      expect(await h!.ui.text("[data-testkit-echo]")).toBe("TESTKIT_ECHO_UI");
      const shot = await h!.ui.screenshot(join(h!.paths.artifacts, "webui-extension-marker.png"));
      console.log(`[evidence] webui screenshot: ${shot}`);
    });

    await rep.check(WEBUI_TURN_CHECK, async () => {
      // A real user clicks "New session" first — the composer only exists once a
      // session is selected. Drive it through the page, not the API.
      await h!.ui.clickText("New session");
      const marker = `TESTKIT_WEBUI_${Date.now().toString(36)}`;
      await h!.ui.waitForSelector("[data-oc-composer-input]", { timeoutMs: 25_000 });
      await h!.ui.fill("[data-oc-composer-input]", marker);
      await h!.ui.press("[data-oc-composer-input]", "Enter");
      await h!.ui.waitFor(
        `document.body.innerText.includes(${JSON.stringify(marker)})`,
        { timeoutMs: 25_000 },
      );
      const transcript = await h!.ui.text("[data-oc-transcript]");
      expect(transcript ?? "").toContain(marker);
      const shot = await h!.ui.screenshot(join(h!.paths.artifacts, "webui-user-turn.png"));
      console.log(`[evidence] webui screenshot: ${shot}`);

      // Cross-check (CLAIM): the same turn exists engine-side.
      const sessions = await h!.client.listSessions(5);
      expect(sessions.length, "engine has a session").toBeGreaterThan(0);

      // Proxy-stratum event tap now sees the turn's engine events (no browser
      // attached to the tap — it is the proxy's own subscription).
      const tap = await h!.waitFor(async () => {
        const r = await h!.client.extJSON<{ count: number }>(EXT_ID, "events");
        return r.count > 0 ? r : false;
      }, { timeoutMs: 20_000, label: "proxy event tap counted engine events" });
      expect(tap.count).toBeGreaterThan(0);
    });
  }

  // -------------------------------------------------------------------------
  // REAL CLIENT 2 — the opencode TUI in a real terminal (tmux). The text grid
  // is the PRIMARY assertion and needs NO browser.
  // -------------------------------------------------------------------------
  let tuiTyped = "";
  await rep.check("tui — real interactive client renders and accepts typed input (EVIDENCE: text grid)", async () => {
    await h!.tui.start();
    const first = await h!.tui.screen();
    expect(first.length, "terminal buffer non-empty").toBeGreaterThan(0);
    tuiTyped = `TESTKIT_TUI_${Date.now().toString(36)}`;
    await h!.tui.type(tuiTyped);
    await h!.tui.waitForText(tuiTyped, { timeoutMs: 15_000 });
    // ASSERTION SUBSTRATE: the text grid is what an agent asserts on (browser-free).
    const grid = await h!.tui.saveScreen("tui-typed.txt");
    console.log(`[evidence] tui grid (assert on this): ${grid}`);
  });

  // HUMAN-FACING, additive, browser-only: the same buffer rendered through
  // xterm.js to a PNG. The emulator's read-back text proves it ingested the
  // buffer; the PNG is illustrative, not a pixel contract. SKIPped cleanly when
  // there is no browser.
  const TUI_RENDER_CHECK = "tui — human-facing render PNG via xterm.js in Chromium (browser; illustrative)";
  if (!h.browser.available) {
    rep.skip(TUI_RENDER_CHECK, `${h.browser.reason} — set CHROME_PATH or install a browser to run it`);
  } else {
    await rep.check(TUI_RENDER_CHECK, async () => {
      const ansi = await h!.tui.saveAnsi("tui-typed.ansi");
      const render = await h!.tui.renderPng("tui-typed.png");
      console.log(`[evidence] tui ansi: ${ansi}`);
      console.log(`[evidence] tui render (human view): ${render.path}`);
      // The render is illustrative, not a pixel contract: xterm.js may wrap a row
      // differently from the real pane. Compare whitespace-insensitively — this
      // proves the emulator ingested the buffer without asserting its layout.
      expect(render.text.replace(/\s+/g, ""), "xterm.js ingested the captured buffer").toContain(tuiTyped);
      expect(statSync(render.path).size, "render PNG is a non-trivial image").toBeGreaterThan(3_000);
    });
  }

  await rep.check("tui — submitting the prompt renders a real turn (EVIDENCE: real user path)", async () => {
    await h!.tui.key("Enter");
    await new Promise((r) => setTimeout(r, 1_500));
    // The engine ships free models (2.0.22+), so a submitted prompt usually
    // renders an actual assistant turn; with no usable model it renders an
    // error/deprecation result instead. Both are the RENDERED, user-visible
    // outcome of the real user path, so accept EITHER — never only the error
    // (waiting solely for an error made this check red once free models landed).
    const screen = await h!.tui.waitForScreen(
      (s) =>
        /Error:|Session failed|has been deprecated|Interrupted/.test(s) ||
        // A completed assistant turn: the "Thought" marker, or the per-turn
        // footer carrying its duration + throughput ("· 34.4s · 2.0 tok/s").
        /Thought ·\s*\d/.test(s) ||
        /·\s*\d+(\.\d+)?s\s*·\s*[\d.]+ ?tok\/s/.test(s),
      { timeoutMs: 90_000, label: "tui turn rendered" },
    );
    const rendered = screen.split("\n").filter((l) => l.trim().length > 0);
    expect(rendered.length, "rendered terminal buffer has content").toBeGreaterThan(0);
    const shot = await h!.tui.saveScreen("tui-turn.txt");
    console.log(`[evidence] tui buffer: ${shot}`);
    // Cross-check (CLAIM): the engine agrees a session exists.
    const sessions = await h!.client.listSessions(5);
    expect(sessions.length, "engine has a session").toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Model-dependent positive turn — OPT-IN, never required.
  // -------------------------------------------------------------------------
  if (!process.env.TESTKIT_MODEL || !h.providerCreds) {
    rep.skip(
      "model-dependent turn (opt-in)",
      "the isolated engine ships no provider credentials, so a real model turn is off by default; enable with TESTKIT_PROVIDER_CREDS=1 TESTKIT_MODEL=<provider/model> (the provider must be discoverable in the isolated config)",
    );
  } else {
    await rep.check("model — positive turn via the real TUI (opt-in)", async () => {
      await h!.tui.send("Reply with exactly: TESTKIT_MODEL_OK");
      await h!.tui.waitForText("TESTKIT_MODEL_OK", { timeoutMs: 120_000 });
      await h!.tui.saveScreen("tui-model-turn.txt");
    });
  }

  // -------------------------------------------------------------------------
  await rep.check("artifacts — screenshots + logs + rendered buffers are saved", async () => {
    const { dir, files } = await h!.dumpArtifacts();
    expect(files.length, "artifact files written").toBeGreaterThan(0);
    console.log(`[artifacts] ${dir}\n  ${files.join("\n  ")}`);
  });
} catch (err) {
  rep.rows.push({
    label: "SETUP/teardown (fatal)",
    status: "FAIL",
    detail: (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 2_000),
  });
  if (h) await h.dumpArtifacts().catch(() => {});
} finally {
  await h?.stop();
}

process.exit(rep.print("testkit example"));
