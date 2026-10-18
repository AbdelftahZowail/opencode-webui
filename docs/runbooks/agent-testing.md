# Agent testing — drive a real client, assert what it rendered

How to test a plugin or webui extension **end-to-end, repeatably, with real
evidence**. One module boots a throwaway OpenCode instance and hands you the
real clients a user would touch.

```
bun run testkit:example        # the worked example (green)
```

- Harness: `scripts/testkit/harness.ts` — `start(opts) → handle`
- Browser resolution: `scripts/testkit/browser.ts` (optional; never bundled)
- Real browser: `scripts/testkit/ui.ts` (the environment's Chromium)
- Real TUI: `scripts/testkit/tui.ts` (tmux + `opencode`)
- Worked example: `scripts/testkit/example.test.ts`
- Fixture (4 strata): `scripts/testkit/fixtures/testkit-echo/`

Runs from a repo checkout **and** from an installed package: `opencode-webui
testkit example|run <spec>|list`. It resolves its own files and spawns the
installed server entry, so it works outside a checkout. The testkit files ship
in the npm tarball (`scripts/testkit/**`) and its agent skill
(`skills/testkit/SKILL.md`) installs to `~/.config/opencode/skills/testkit/` on
boot (the same mechanism as the webui skill).

Prerequisites: the v2 engine (`opencode2`) and `tmux`. A browser is **optional
and never bundled** — testkit does not ship one. It points at the Chromium your
environment already has (an explicit `chrome`/`TESTKIT_CHROME`, `CHROME_PATH` /
`CHROMIUM_PATH` / `CHROME`, the Playwright cache, or a system Chromium on PATH);
the browser checks skip cleanly when there is none.

## The rule: the browser is optional (point, don't bundle)

**testkit does not bundle a browser — point it at the one your environment
already has; the browser checks skip cleanly without one.** Nothing about
engine, proxy, or TUI-text testing needs a browser: `start()` resolves one once
(see `scripts/testkit/browser.ts`) and exposes `handle.browser.available` plus
the reason. Gate browser work on it:

```ts
if (h.browser.available) {
  await rep.check("webui renders the extension", async () => { /* h.ui.* */ });
} else {
  rep.skip("webui renders the extension", `${h.browser.reason} — install a browser or set CHROME_PATH`);
}
```

`handle.ui` fails soft (every method throws `BrowserUnavailableError` carrying
one actionable line) and so does `handle.tui.renderPng()`. `TESTKIT_NO_BROWSER=1`
forces the no-browser path (used to prove the skip holds). Resolution prefers the
driver's own cached Chromium over a distro/Snap Chromium on PATH, because a
confined Snap browser often cannot be launched by the driver.

## The rule: evidence, not claims

An API response is a **claim** — it can return `ok` while the UI rendered
nothing. The proof is what a **real client rendered**:

| Real client | Evidence you assert on |
| --- | --- |
| `handle.ui` (Chromium) | rendered DOM text, element counts, screenshots (`PNG`) |
| `handle.tui` (tmux) | the terminal buffer from `capture-pane -p` |
| `handle.client` (API) | **cross-check / setup only** — never the sole proof |

Where a user can perform an action, drive it from the client (click, type,
send). Use `handle.client` only to set up state a headless client cannot create
or to cross-check an outcome.

Screenshots and terminal buffers are always written to the artifacts dir
**outside** the scratch root, so `stop()` still cleans temp dirs and the
evidence survives. An agent whose model can read images can open the PNGs.

## TUI: two representations

The TUI produces two artifacts with two jobs:

- **Assertion substrate — the text grid.** `handle.tui.screen()` /
  `saveScreen()` read `tmux capture-pane -p`: deterministic, agent-optimized.
  **Assert on this**; colors carry no layout meaning.
- **Human-facing render — a PNG.** `handle.tui.renderPng()` (additive) replays
  the same buffer *with ANSI* (`saveAnsi()`) through xterm.js in headless
  Chromium and screenshots it, so a human can eyeball the colors. It needs a
  browser — skip it when `handle.browser.available` is false. It is
  **illustrative, not a pixel contract**: emulators disagree on exact
  widths/glyphs, so never assert layout on the render. `renderPng()` returns the
  emulator's read-back text; normalize whitespace before comparing (a row may
  wrap differently). Uses the already-shipped `@xterm/xterm`; the browser comes
  from `./browser`, not from a bundled copy.

## Quickstart

```ts
import { join } from "node:path";
import { start, Reporter, expect } from "./scripts/testkit/harness";

const h = await start({ extensions: [join(import.meta.dir, "my-ext")] });
const rep = new Reporter();
rep.onFailure(() => h.dumpArtifacts());          // screenshot + logs on failure
try {
  await rep.check("webui shows the extension", async () => {
    await h.ui.goto("/");                         // real Chromium page
    await h.ui.clickText("New session");
    await h.ui.waitForSelector("[data-oc-composer-input]");
    await h.ui.fill("[data-oc-composer-input]", "hello");
    await h.ui.press("[data-oc-composer-input]", "Enter");
    await h.ui.waitFor(`document.body.innerText.includes("hello")`);
    await h.ui.screenshot();                      // evidence
    expect(await h.ui.text("[data-oc-composer-input]")).toBe("");
  });

  await rep.check("tui shows the turn", async () => {
    await h.tui.start();                          // real tmux pane
    await h.tui.send("hello");
    await h.tui.waitForText("hello");             // what the user sees
    await h.tui.saveScreen();                     // assertion substrate
    await h.tui.renderPng();                      // human-facing PNG (additive)
  });
} finally {
  await h.stop();                                 // idempotent; kills every child
}
process.exit(rep.print("my extension"));
```

Browser steps (`h.ui.*`, `h.tui.renderPng()`) are optional — guard them on
`h.browser.available` (the rule above) so a browser-less machine still passes the
non-browser checks.

## `start(opts) → handle`

`opts`: `extensions?: string[]` (installed after boot), `root?`, `artifactsDir?`,
`keep?`, `providerCreds?`, `model?` (enables a real turn), `env?` (extra proxy
env), `engineBin?`, `chrome?` (explicit browser), `verbose?`, `timeouts?`.

`handle`:

- `engine` — `{ url, password, pid, port, bin }`; `proxy` — `{ url, port, pid }`.
  `paths` holds the temp dirs.
- `browser` — the resolution from `./browser`: `{ available, source?, executablePath?, reason? }`.
  Gate browser checks on `browser.available` (the runbook rule above).
- `client` — supplementary API wrapper: `createSession`, `prompt(sid, text, "steer"|"queue")`,
  `waitIdle`, `messages`/`transcript`, `interrupt`, `permissions`/`replyPermission`,
  `forms`/`replyForm`, `questions`/`answerQuestion`, `ext(id, path)` / `extJSON` /
  `extPost` (proxy ext routes + KV), and `client.events` (buffered `/api/event`
  SSE: `waitFor(pred)`, `waitForType(t)`, `all()`, `ofType(t)`).
- `ui` — real browser: `goto`, `evaluate`, `waitFor(expr)`, `waitForSelector`,
  `click`, `clickText`, `fill` (React-safe), `press`, `text`, `count`, `bodyText`,
  `screenshot`, `consoleTail`, `close`. Optional: `ui.available` is false with no
  browser and every method throws `BrowserUnavailableError` (one actionable line).
  Lazy: the first call starts Chromium, and Vite only in a repo checkout (an
  installed package serves `dist/` from the proxy).
- `tui` — real terminal: `start`, `type`, `key("Enter")`, `send`, `screen()`
  (the text grid — what the user sees), `history()`, `waitForScreen(pred)`,
  `waitForText`, `saveScreen`, `ansi()`/`saveAnsi()` (with SGR colors),
  `renderPng()` (human-facing PNG; needs a browser — skip without one),
  `resize`, `close`. Lazy; **`start()` waits
  for the client to paint before you type**.
- `install(extDir)` — copies the folder into the isolated extension dir and waits
  until **all four strata** are live (manifest + bundle, `dom.ts`, `server.ts`
  route, `engine/` payload active), with a timeout and a legible failure.
- `restartEngine()`, `waitFor(fn, {timeoutMs})`, `dumpArtifacts()`, `engineLog()`,
  `proxyLog()`, `stop()`.
- Helpers: `expect(actual, label)` (`.toBe/.toEqual/.toContain/.toMatch/.toBeGreaterThan`),
  `assert(cond, label)`, `Reporter` (`check`/`skip`/`print`), `liveServiceFingerprint()`.

## Isolation & safety (why this is safe to run anywhere)

One `start()`:

- **engine** — `opencode2 serve --service` with its OWN `XDG_CONFIG_HOME` /
  `XDG_STATE_HOME` / `XDG_DATA_HOME`, OWN cwd, and a free port. Its
  `service.json` lives under the temp state dir; the developer's live
  `~/.local/state/opencode/service.json` is never read or written.
- **proxy** — a webui on its own port pointed at THAT engine
  (`WEBUI_ENGINE_URL`/`WEBUI_ENGINE_PASSWORD`, `WEBUI_NO_SETUP=1`,
  `WEBUI_SANDBOX=1`) with an isolated `WEBUI_EXTENSION_DIR`. Never claims the
  shared pidfile.
- **clients** — an isolated Chromium and an isolated tmux server
  (`tmux -L <unique-socket>`). It never touches the production webui/engine.

`stop()` is idempotent and kills engine, proxy, Vite, Chromium, and the tmux
server, then removes the scratch dir. SIGINT/SIGTERM run the same teardown
(so `timeout` is safe). `TESTKIT_KEEP=1` keeps the scratch dir for debugging;
`TESTKIT_SCRATCH=/path` overrides the scratch root.

## Model-dependent steps are opt-in

The isolated engine ships **no provider credentials** (that would touch the
developer's real setup), so a real model turn cannot run by default. Gate such
steps and say so — the example `SKIP`s them. `start({ model })` (or
`TESTKIT_MODEL`) writes a default model into the isolated config and
`providerCreds` copies the real `auth.json` in; a positive turn still requires
the provider to be **discoverable** in the isolated config (an isolated config
dir has no provider packages), so treat it as best-effort:

```
TESTKIT_PROVIDER_CREDS=1 TESTKIT_MODEL=<provider/model> bun run testkit:example
```

Prove timing guards **both ways** (remove the guard → red → restore → green).
`TESTKIT_TUI_NO_READY=1` exists to demonstrate the TUI ready-wait is not vacuous.
`TESTKIT_NO_BROWSER=1` forces the no-browser path so the browser checks' SKIP can
be proven the same way (green with a browser, green with the browser checks
skipped and the same clear reason).

## Two gotchas worth knowing

- **Folder name must equal `manifest.id`.** Core's server-extension loader keys
  its `loaded` map by manifest id but its removal scan by folder name; a
  mismatch reloads the module every 2s. Name the folder `my-ext/` and set
  `"id": "my-ext"`. (`install()` notes this.)
- **`engine/` payloads need an engine restart.** The webui does not install
  extension engine plugins (see `docs/reference/engine-payload-convention.md`);
  `install()` adds the payload to the isolated config and restarts the isolated
  engine for you. The service password is stable for a fixed state dir, so the
  pinned proxy keeps working across the restart.
