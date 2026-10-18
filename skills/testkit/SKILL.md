---
name: testkit
description: testkit — the opencode-webui end-to-end test harness: an isolated engine + proxy driven through the REAL clients (the environment's real Chromium page when present — never bundled — and the real opencode TUI in tmux), asserting on RENDERED evidence. Load to test/verify the webui or an extension like a real user.
---

# testkit — drive a real client, assert what it rendered

`testkit` boots a **fully isolated** OpenCode v2 engine + an opencode-webui
proxy in throwaway XDG dirs on free ports, installs an extension under test, and
hands you the **real clients a user actually touches**: a real Chromium page
from the environment (never bundled — see below) and the real `opencode`
interactive client in a real tmux terminal. It asserts on what those clients
**rendered** — DOM text, the terminal buffer, screenshots — not on API responses.

- **Repo**: https://github.com/AbdelftahZowail/opencode-webui
- **This skill's version**: 3.4.2 (matches the `v3.4.2` tag; the file
  links below are pinned to it)
- **Run it** (npm / bunx install — works from any directory):
  ```sh
  opencode-webui testkit example        # the worked example (green)
  opencode-webui testkit run <spec.ts>  # run your own spec file
  opencode-webui testkit list           # shipped files + the import path
  ```
  From a checkout: `bun run testkit:example`.

> **The browser is optional — testkit does not bundle one.** It points at the
> Chromium your environment already has (an explicit/`CHROME_PATH` browser, the
> Playwright cache, or a system Chromium); `handle.ui` and `handle.tui.renderPng()`
> FAIL SOFT with one actionable line when there is none, and the harness exposes
> `handle.browser.available`. Gate browser checks on it and let them SKIP — the
> engine, proxy, and **TUI text grid** checks all run without a browser.

## The rule: evidence, not claims

An API response is a **claim** — it can return `ok` while the UI rendered
nothing. Only what a **real client rendered** is evidence:

| Real client | Evidence you assert on |
| --- | --- |
| `handle.ui` (Chromium) | rendered DOM text, element counts, screenshots (PNG) |
| `handle.tui` (tmux) | the terminal buffer (exactly what the user sees) |
| `handle.client` (API) | **cross-check / setup only** — never the sole proof |

Where a user can perform an action, drive it from the client (click, type,
send); use the API only to set up state a headless client cannot create.

### TUI: two representations

The TUI has two artifacts with two jobs:

- **Assertion substrate — the text grid** (`handle.tui.screen()` /
  `saveScreen()`, from `tmux capture-pane -p`). Deterministic and
  agent-optimized; **assert on this**. Colors carry no layout meaning.
- **Human-facing render — a PNG** (`handle.tui.renderPng()`, additive; needs a
  browser — SKIP it when `handle.browser.available` is false). The same
  buffer (with ANSI, via `saveAnsi()`) is replayed through xterm.js in headless
  Chromium and screenshotted so a human can eyeball it. It is **illustrative, not
  a pixel contract** — emulators disagree on exact widths/glyphs; never assert
  layout on the render. It returns the emulator's read-back text; normalize
  whitespace before comparing (a row may wrap differently).

## Quickstart (a spec file)

```ts
import { join } from "node:path";
import { start, Reporter, expect } from "opencode-webui/scripts/testkit/harness";

const h = await start({ extensions: [join(import.meta.dir, "my-ext")] });
const rep = new Reporter();
rep.onFailure(() => h.dumpArtifacts());               // logs + shots on failure
try {
  await rep.check("webui renders the extension", async () => {
    await h.ui.goto("/");                              // real Chromium page
    await h.ui.clickText("New session");
    await h.ui.waitForSelector("[data-oc-composer-input]");
    await h.ui.fill("[data-oc-composer-input]", "hello");
    await h.ui.press("[data-oc-composer-input]", "Enter");
    await h.ui.waitFor(`document.body.innerText.includes("hello")`);
    await h.ui.screenshot();                           // evidence
  });
  await rep.check("tui renders the turn", async () => {
    await h.tui.start();                               // real tmux pane
    await h.tui.send("hello");
    await h.tui.waitForText("hello");                  // what the user sees
    await h.tui.saveScreen();                          // assertion substrate
    await h.tui.renderPng();                           // human-facing PNG (additive)
  });
} finally {
  await h.stop();                                      // idempotent teardown
}
process.exit(rep.print("my extension"));
```

Run it with `opencode-webui testkit run ./my-ext.test.ts` (or `bun run` the
file directly from a checkout). Guard browser steps on `h.browser.available`
(`h.ui.*` and `h.tui.renderPng()`) so a machine with no browser still gets a
green non-browser run — the worked example does exactly this.

## Install and drive an extension

`start({ extensions: [dir] })` (or `handle.install(dir)`) copies the folder
into the isolated extension dir and waits until **all strata are live**: the
browser bundle (by URL), `dom.ts`, the proxy `server.ts` route, and the
`engine/` payload (added to the isolated config + the isolated engine
restarted). The extension **folder name must equal `manifest.id`**.

Then drive it like the user: `h.ui.*` in the browser, `h.tui.*` in the
terminal, and assert on what rendered. Screenshots and terminal buffers are
written to the artifacts dir **outside** the scratch root, so they survive
`stop()`; an agent that can read images can open the PNGs. The shipped
four-strata fixture is a copy-paste starting point:
`scripts/testkit/fixtures/testkit-echo/`.

## Non-guarantees (read before trusting a green run)

- **TUI-only behaviour is TUI-only.** A green `ui` check says nothing about the
  TUI, and vice-versa — drive both where the user can use both.
- **Model turns need credentials.** The isolated engine ships **no** provider
  credentials (that would touch the developer's real setup), so a real model turn
  is opt-in and best-effort: `TESTKIT_PROVIDER_CREDS=1 TESTKIT_MODEL=<provider/model>`.
  Without them, model-dependent steps are SKIPped — say so; never claim them.
- **Coverage = the paths you drive.** The harness proves exactly what your spec
  exercises. It is not a regression suite and does not enumerate routes.
- **The TUI render is illustrative.** `renderPng()` produces a human-facing PNG
  through xterm.js; it can differ from the real terminal in wrapping/glyphs.
  Assert on the text grid, never on the render.
- **Prerequisites.** The v2 engine (`opencode2`) and `tmux` are required. A
  browser is **optional** and never bundled — with none the browser checks SKIP
  cleanly (gate on `handle.browser.available`); install one or set `CHROME_PATH`
  to run them.
- **Isolation is bounded.** Engine, proxy, cwd, ports, and extension dir are
  isolated and the harness never touches the production webui/engine — but it
  does run real engine/browser/tmux processes on the host.

## Source catalog (fetch, don't read a local checkout)

| File | Purpose |
| --- | --- |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v3.4.2/docs/runbooks/agent-testing.md | The full runbook — harness API, isolation model, gotchas |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v3.4.2/scripts/testkit/harness.ts | `start()`, the API client, `Reporter`, `expect`, `waitFor`, isolation helpers |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v3.4.2/scripts/testkit/browser.ts | Browser resolution — points at the environment's browser; never bundles one |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v3.4.2/scripts/testkit/ui.ts | The real-Chromium driver (optional; FAILS SOFT without a browser) |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v3.4.2/scripts/testkit/tui.ts | The real tmux + `opencode` driver (`renderPng()` needs a browser; the text grid does not) |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v3.4.2/scripts/testkit/example.test.ts | The worked example |
| https://raw.githubusercontent.com/AbdelftahZowail/opencode-webui/v3.4.2/scripts/testkit/fixtures/testkit-echo/manifest.json | The four-strata fixture (`manifest.json` + `index.tsx`/`dom.ts`/`server.ts`/`engine/`) |
