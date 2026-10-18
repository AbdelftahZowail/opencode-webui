#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
/**
 * Regenerates skills/webui/SKILL.md from webui-extensions/README.md.
 *
 * The skill IS the agent-context injection: its frontmatter description is
 * always visible to every opencode agent (bodies load on demand), so the
 * description makes agents aware of the webui without bloat. The extension
 * tables in the body are EXTRACTED from webui-extensions/README.md so they can
 * never drift from the authoring guide.
 *
 * Deterministic: extraction follows source document order, output has no
 * timestamps, and re-running produces byte-identical output.
 *
 * Usage: bun run gen:skill
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "webui-extensions", "README.md");
const TARGET = join(ROOT, "skills", "webui", "SKILL.md");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const VERSION = PKG.version;
const REPO = "AbdelftahZowail/opencode-webui";
/** Raw file links pinned to the released tag — the version the skill ships in. */
const RAW = (path: string) =>
  `https://raw.githubusercontent.com/${REPO}/v${VERSION}/${path}`;

/**
 * ONE tight line that triggers when: the user mentions the webui/web
 * frontend, asks about webui extensions, or wants to report a webui bug.
 * Keep it to ONE tight line — this is the always-visible injection.
 */
const DESCRIPTION =
  "opencode-webui — the browser frontend for the OpenCode engine. Load when the user mentions the webui/web frontend, asks about webui extensions, wants to BUILD, ADD, CHANGE, DEBUG, or TEST a webui extension, or wants to report a webui bug (/report does it).";

// ---------------------------------------------------------------------------
// Extraction helpers (webui-extensions/README.md is the single source of truth)
// ---------------------------------------------------------------------------

/** A markdown table: the line matching `header`, then every `|`-led line after. */
function extractTable(src: string, header: RegExp, label: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) throw new Error(`gen-skill: ${label} header not found in ${SOURCE}`);
  const rows: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (!line.trimStart().startsWith("|")) break;
    rows.push(line);
  }
  if (rows.length < 3) throw new Error(`gen-skill: ${label} table looks truncated`);
  return rows.join("\n");
}

const readme = readFileSync(SOURCE, "utf8");

const kindTable = extractTable(
  readme,
  /^\| Kind \| Job \|/,
  "five kinds",
);
const hookTable = extractTable(
  readme,
  /^\| Event \| `?ctx.*shape.*\|/i,
  "hook catalog",
);
const anchorTable = extractTable(
  readme,
  /^\| Anchor \| Site \|/,
  "DOM anchors",
);

// ---------------------------------------------------------------------------

const skill = `---
name: webui
description: ${DESCRIPTION}
---

# OpenCode webui (opencode-webui)

The browser frontend for the OpenCode engine — same engine, same sessions as
the \`opencode\` TUI, with a Bun proxy in front so the browser never holds
service credentials. One port for UI + \`/api/*\`: http://localhost:4097
(\`WEBUI_PROXY_PORT\`).

On first boot the webui self-installs a global \`opencode-webui\` command and two
OpenCode plugins under \`~/.config/opencode/plugins/\`: a lifecycle plugin
(\`opencode-webui/\`) that starts it as soon as you use OpenCode — so an instance
is usually already running at that port — and a shelf tools plugin
(\`opencode-webui-shelf/\`) exposing the \`shelf_share\`/\`shelf_list\`/\`shelf_remove\`
tools. Check before starting another (a second run reports "already running" and
exits 0). Manage it with \`opencode-webui update|status|stop|restart|uninstall\`;
\`WEBUI_NO_SETUP=1\` skips setup for a one-off run.

Serve/security settings (host, port, auth, allowed hosts, trust proxy, autostart)
persist in \`~/.config/opencode/webui/config.json\` — environment variables
override the file — and are edited with \`opencode-webui config get|set|unset\` or
in **Settings › Access**; changes apply after a restart. Authentication is
optional (\`auth: none\`) for private networks/proxies, but reachable-without-a-
password changes need explicit confirmation.

- **Repo**: https://github.com/${REPO}
- **This skill's version**: ${VERSION} (matches the \`v${VERSION}\` git tag —
  the file links below are pinned to it, so they always describe the code
  this skill was generated with)
- **A running instance exposes its version** at \`GET /api/webui/config\` →
  \`{ version, reportRepo }\`, and on the page as \`window.__opencodeUI.version\`.

## Source catalog (fetch, don't read local checkouts)

Everything needed to author extensions is below; when a table isn't enough,
fetch the exact file at the pinned tag instead of reading a local clone:

| File | Purpose |
| --- | --- |
| ${RAW("webui-extensions/README.md")} | Full authoring guide — the source of truth for strata/kinds/hooks/anchors |
| ${RAW("src/extensions/registry.tsx")} | The extension registry — exact register() shapes per kind |
| ${RAW("src/extensions/context.ts")} | Activation context — the \`activate(ctx)\` entry, disposal, and the full \`ctx\` surface |
| ${RAW("src/extensions/slots.tsx")} | Slot ids (placement contract) + the Slot renderer |
| ${RAW("src/extensions/manifest.ts")} | Manifest contract — settings schema + requires parsing/checks |
| ${RAW("src/extensions/hooks.ts")} | Shared fireHooks runner — how open hook events fire |
| ${RAW("src/lib/domKit.ts")} | DOM-stratum kit (foreign/watch/styles) + the data-oc-* anchor table |
| ${RAW("src/lib/storeFacade.ts")} | Curated store surface extensions get as \`store\` (raw module = \`advanced.store\`) |
| ${RAW("src/lib/eventBus.ts")} | Event bus — raw engine events + derived lifecycle, frame-batched |
| ${RAW("src/lib/extSettings.ts")} | Per-extension declared settings — schema, resolve, persist, subscribe |
| ${RAW("src/lib/extBus.ts")} | Extension-to-extension peer bus (publish/subscribe) |
| ${RAW("server/ext/types.ts")} | Proxy-stratum types — server.ts routes/middleware/onEvent/pollers shapes |
| ${RAW("docs/reference/extension-system-spec.md")} | The v2 decision record — strata, precedence, deletions, acceptance checks |
| ${RAW("src/store.ts")} | The raw store module (reachable as \`advanced.store\`; prefer the facade) |

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| \`WEBUI_PASSWORD\` | generated on first boot, printed once | Shared login passphrase. |
| \`WEBUI_HOST\` | \`127.0.0.1\` | Bind address — a wildcard is refused without a password. |
| \`WEBUI_PROXY_PORT\` | \`4097\` | Port for the UI and \`/api/*\`. |
| \`WEBUI_NO_SETUP\` | unset | \`1\` — skip first-run setup (global command + engine plugins) for this run. |
| \`WEBUI_NO_PLUGIN\` | unset | \`1\` — install the global command but not the OpenCode engine plugins (lifecycle + shelf tools). |
| \`WEBUI_EXTENSION_DIR\` | the global + project dirs | Replace both with ONE directory (the sandbox does this to keep WIP isolated). |
| \`WEBUI_ENGINE_URL\` | \`service.json\` discovery | Aim the proxy at a chosen engine — skips \`Service.ensure()\`, so a stale pid can never spawn a rogue serve. Explicit env wins. |
| \`WEBUI_ENGINE_PASSWORD\` | \`service.json\` password | Engine password for the override above (no file fallback when the URL is overridden — a chosen engine has its own credential). |
| \`WEBUI_SANDBOX_NOVITE\` | unset | \`1\` — sandbox boots the proxy only, no Vite (\`--no-vite\` flag does the same). |
| \`WEBUI_CRASH_LOG\` | \`$XDG_STATE_HOME/opencode-webui/proxy-crash.log\` | File fatal proxy errors (\`uncaughtException\`/\`unhandledRejection\`) are appended to; the last entry prints on next boot. |
| \`WEBUI_DEBUG\` | unset | \`1\` — server/proxy debug logs to stdout. |
| \`WEBUI_DEBUG_LOG\` | \`/tmp/webui-debug.log\` | File the frontend log sink (\`POST /api/debug\`) appends to. |

### Parallel sandboxes (one per extension under test)

Yes — run as many sandboxes at once as you need. \`bun run sandbox\` stacks
with no flags: the first instance takes the fixed defaults (\`:4099\`/\`:5175\`
+ shared scratch dir); every further instance detects the busy ports and
auto-isolates onto free ports + a fresh mkdtemp extension dir, printing what
it picked. Explicit env (\`WEBUI_PROXY_PORT\` / \`WEBUI_VITE_PORT\` /
\`WEBUI_EXTENSION_DIR\`) always wins per knob. The engine stays shared
(same sessions everywhere, by design) — only ports + extension dirs are
isolated. Rules: one sandbox per extension, never two writers to one ext
dir, never reuse a port.

## What you can do for the user

- **File a webui bug** — the composer ships a built-in \`/report\` command that
  bundles diagnostics (build version, user agent, enabled extension ids, error
  ring) into a prefilled GitHub issue for AbdelftahZowail/opencode-webui (see
  Reporting bugs below).
- **Explain the extension system** from the tables below — they are extracted
  verbatim from the authoring guide (\`webui-extensions/README.md\`), which is the
  source of truth.
- **Author an extension folder** for the user — one folder, no build step, no
  restart. Pick the stratum that matches the job (React tree → browser,
  portals/canvas/post-render → dom.ts, headless/always-on → server.ts,
  model tools → engine/).

## The model in one minute

One extension = **one folder**: \`manifest.json\` (id, version, description,
\`disabled\`?, \`settings\`?, \`requires\`?) + \`index.tsx\` (browser stratum) +
\`dom.ts\` (DOM stratum) + \`server.ts\` (proxy stratum) + \`engine/\` (opencode
plugin payload).
Presence = installed; \`disabled: true\` = paused; delete the folder =
uninstalled. Precedence, highest wins: \`~/.config/opencode/webui-extensions/\`
(user) → \`<project>/.opencode/webui-extensions/\` (project) → shipped
\`webui-extensions/\` (ours). Dropping a folder in the extension dir is an
act of trust — extension code is not sandboxed.

### Add / pause / remove

| Action | How |
| --- | --- |
| Add | Create \`webui-extensions/<name>/\` with \`manifest.json\` + \`index.tsx\` calling \`register({ kind, ... })\`. Loads without rebuild/refresh/restart (manifest SSE push, same-id swap). |
| Pause | Set \`"disabled": true\` in its \`manifest.json\` — gone on the next manifest push. |
| Remove | Delete/move the folder — the id vanishes from the manifest. |
| Shadow | Same id at higher precedence wins; core updates still flow everywhere else. |

Authoring rules (kinds, hook events) are identical in every source — the
tables below apply to each. Full hot-reload guarantees and the timestamp
worked example are in the authoring guide.

### Minimal extension (wrap — the default path for edits)

\`\`\`tsx
// ~/.config/opencode/webui-extensions/my-time/{manifest.json,index.tsx}
import { register } from "opencode-webui/extensions"; // shipped dirs import from src; external dirs use the extension API surface

register({
  kind: "wrap",
  id: "my-time",
  target: "Timestamp",
  render: (props, next) => <span className="tabular-nums">{next()}</span>,
});
\`\`\`

### Activation context (browser stratum)

Prefer \`export function activate(ctx)\` over module-scope \`register()\` — the
context owns lifecycle + disposal. On it: \`ctx.register(entry)\` (the five
kinds); \`ctx.poll({ name, minInterval, run })\` and \`ctx.after(ms, fn)\` (the
shared tier-aware scheduler, auto-stopped); \`ctx.on(name, fn)\` (event bus —
a raw engine type or a derived name: \`run.started\`, \`run.ended\`,
\`tool.called\`, \`tool.completed\`, \`message.appended\`; \`"*"\` = all);
\`ctx.subscribe(selector, fn)\` (derived store read); \`ctx.store\` (curated
store facade — selectors + actions); \`ctx.settings\` (declared settings);
\`ctx.collections\` / \`ctx.bus\` (peer composition); \`ctx.onDispose(fn)\` or
returning a teardown. Everything a context creates is disposed on hot-swap,
\`disabled\`, and delete. Module-scope \`register()\` still works but is being
deprecated.

Manifest \`settings\` declares options core renders in Settings › Extensions;
\`requires\` (\`api\`/\`targets\`/\`slots\`/\`services\`) is checked on every
sync and an unmet reference is a visible warning, not a silent blank spot.

## Five kinds, one job each (the contract)

${kindTable}

Contribute collections (registry-owned lists — data, not new kinds):
\`palette\`, \`slash\` (UI-only; engine commands win name clashes),
\`pages\` (routed at \`/ext/{id}\`), \`settings\`,
\`markdown.codeBlock\` (fenced-code renderers keyed by info-string — \`markdown.registerCodeBlockRenderer\` on the bridge; see the authoring guide),
\`contextMenu.message\` / \`contextMenu.session\` / \`contextMenu.file\`, and
\`slot:<id>\` (named placement points — \`conversation.header.actions\`,
\`conversation.empty\`, \`composer.above\`, \`composer.actions\`,
\`sidebar.header.actions\`).

A \`contextMenu.*\` item's \`run(ctx)\` receives \`{ sessionID?, messageID?, file? }\`:
\`file\` is the path and is populated only for \`contextMenu.file\` (consumed by
the FileExplorer's file rows on right-click); \`messageID\` only for
\`contextMenu.message\`; \`sessionID\` for the session and file menus.

### Hook catalog

${hookTable}

Browser hooks affect only their own browser — transforms affecting *all*
clients go in proxy \`server.ts\` middleware. Proxy mounts (\`server/ext/\`):
\`routes\` at \`/api/webui/ext/<id>/…\`, \`middleware\` over \`/api/*\`,
\`onEvent\` tap (works with all tabs closed), \`pollers\`, per-extension KV.

## DOM anchors (the free layer)

\`dom.ts\` + the kit (\`foreign\`/\`watch\`/\`styles\`, mount/dispose) covers
what the React tree cannot: mid-component DOM, portals, canvas/xterm,
iframes. Stable anchors below are contract — renaming one is a version bump
+ migration note. DOM is the marked last resort ("outside the contract; you
own the fragility").

${anchorTable}

## Sandbox (iterate without touching the user's webui)

A second, private instance for authoring/testing extensions — no repo
needed. Start it the same way the package runs, plus \`sandbox\`:
\`bunx opencode-webui sandbox\` (or \`./opencode-webui-<target> sandbox\`).
It binds \`127.0.0.1:4099\` — loopback-only, NO password (a non-loopback
sandbox is refused) — and loads extensions from an ISOLATED scratch dir
(\`~/.local/state/opencode-webui/sandbox-extensions/<name>/\`), so WIP
is invisible to the user's main instance. Same engine, same sessions as the
main instance. Workflow: write the extension folder in the scratch dir →
watch it load in the sandbox via the manifest push (sub-second) → fix until
right → then copy the folder into \`~/.config/opencode/webui-extensions/<name>/\`
to ship it to the user (or \`<project>/.opencode/webui-extensions/<name>/\`
for one project). Do not write user extensions directly into the real dirs
while iterating — that exposes WIP to the user's browser immediately.

## Reporting bugs

\`/report\` in the composer files a prefilled GitHub issue against
AbdelftahZowail/opencode-webui with a diagnostics bundle (build version, user
agent, enabled extension ids, window error ring). \`--agent\` hands the same
bundle to the session agent instead: when the user asks you to file it and
\`gh\` is authenticated, create the issue yourself from the bundle — the webui
never holds GitHub credentials. The engine's built-in \`/report\` skill is a
different thing (different repo, different diagnostics).
`;

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, skill);
console.log(`[gen-skill] wrote ${TARGET} (${skill.length} bytes, description ${DESCRIPTION.length} chars)`);

// ---------------------------------------------------------------------------
// testkit skill (skills/testkit/SKILL.md)
//
// Deliberately NOT extracted from another doc: the body is authored here and
// generated only so its version + raw file links stay pinned to the package
// version, exactly like the webui skill above.
// ---------------------------------------------------------------------------

const TESTKIT_TARGET = join(ROOT, "skills", "testkit", "SKILL.md");
const TESTKIT_DESCRIPTION =
  "testkit — the opencode-webui end-to-end test harness: an isolated engine + proxy driven through the REAL clients (the environment's real Chromium page when present — never bundled — and the real opencode TUI in tmux), asserting on RENDERED evidence. Load to test/verify the webui or an extension like a real user.";

const testkitSkill = `---
name: testkit
description: ${TESTKIT_DESCRIPTION}
---

# testkit — drive a real client, assert what it rendered

\`testkit\` boots a **fully isolated** OpenCode v2 engine + an opencode-webui
proxy in throwaway XDG dirs on free ports, installs an extension under test, and
hands you the **real clients a user actually touches**: a real Chromium page
from the environment (never bundled — see below) and the real \`opencode\`
interactive client in a real tmux terminal. It asserts on what those clients
**rendered** — DOM text, the terminal buffer, screenshots — not on API responses.

- **Repo**: https://github.com/${REPO}
- **This skill's version**: ${VERSION} (matches the \`v${VERSION}\` tag; the file
  links below are pinned to it)
- **Run it** (npm / bunx install — works from any directory):
  \`\`\`sh
  opencode-webui testkit example        # the worked example (green)
  opencode-webui testkit run <spec.ts>  # run your own spec file
  opencode-webui testkit list           # shipped files + the import path
  \`\`\`
  From a checkout: \`bun run testkit:example\`.

> **The browser is optional — testkit does not bundle one.** It points at the
> Chromium your environment already has (an explicit/\`CHROME_PATH\` browser, the
> Playwright cache, or a system Chromium); \`handle.ui\` and \`handle.tui.renderPng()\`
> FAIL SOFT with one actionable line when there is none, and the harness exposes
> \`handle.browser.available\`. Gate browser checks on it and let them SKIP — the
> engine, proxy, and **TUI text grid** checks all run without a browser.

## The rule: evidence, not claims

An API response is a **claim** — it can return \`ok\` while the UI rendered
nothing. Only what a **real client rendered** is evidence:

| Real client | Evidence you assert on |
| --- | --- |
| \`handle.ui\` (Chromium) | rendered DOM text, element counts, screenshots (PNG) |
| \`handle.tui\` (tmux) | the terminal buffer (exactly what the user sees) |
| \`handle.client\` (API) | **cross-check / setup only** — never the sole proof |

Where a user can perform an action, drive it from the client (click, type,
send); use the API only to set up state a headless client cannot create.

### TUI: two representations

The TUI has two artifacts with two jobs:

- **Assertion substrate — the text grid** (\`handle.tui.screen()\` /
  \`saveScreen()\`, from \`tmux capture-pane -p\`). Deterministic and
  agent-optimized; **assert on this**. Colors carry no layout meaning.
- **Human-facing render — a PNG** (\`handle.tui.renderPng()\`, additive; needs a
  browser — SKIP it when \`handle.browser.available\` is false). The same
  buffer (with ANSI, via \`saveAnsi()\`) is replayed through xterm.js in headless
  Chromium and screenshotted so a human can eyeball it. It is **illustrative, not
  a pixel contract** — emulators disagree on exact widths/glyphs; never assert
  layout on the render. It returns the emulator's read-back text; normalize
  whitespace before comparing (a row may wrap differently).

## Quickstart (a spec file)

\`\`\`ts
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
    await h.ui.waitFor(\`document.body.innerText.includes("hello")\`);
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
\`\`\`

Run it with \`opencode-webui testkit run ./my-ext.test.ts\` (or \`bun run\` the
file directly from a checkout). Guard browser steps on \`h.browser.available\`
(\`h.ui.*\` and \`h.tui.renderPng()\`) so a machine with no browser still gets a
green non-browser run — the worked example does exactly this.

## Install and drive an extension

\`start({ extensions: [dir] })\` (or \`handle.install(dir)\`) copies the folder
into the isolated extension dir and waits until **all strata are live**: the
browser bundle (by URL), \`dom.ts\`, the proxy \`server.ts\` route, and the
\`engine/\` payload (added to the isolated config + the isolated engine
restarted). The extension **folder name must equal \`manifest.id\`**.

Then drive it like the user: \`h.ui.*\` in the browser, \`h.tui.*\` in the
terminal, and assert on what rendered. Screenshots and terminal buffers are
written to the artifacts dir **outside** the scratch root, so they survive
\`stop()\`; an agent that can read images can open the PNGs. The shipped
four-strata fixture is a copy-paste starting point:
\`scripts/testkit/fixtures/testkit-echo/\`.

## Non-guarantees (read before trusting a green run)

- **TUI-only behaviour is TUI-only.** A green \`ui\` check says nothing about the
  TUI, and vice-versa — drive both where the user can use both.
- **Model turns need credentials.** The isolated engine ships **no** provider
  credentials (that would touch the developer's real setup), so a real model turn
  is opt-in and best-effort: \`TESTKIT_PROVIDER_CREDS=1 TESTKIT_MODEL=<provider/model>\`.
  Without them, model-dependent steps are SKIPped — say so; never claim them.
- **Coverage = the paths you drive.** The harness proves exactly what your spec
  exercises. It is not a regression suite and does not enumerate routes.
- **The TUI render is illustrative.** \`renderPng()\` produces a human-facing PNG
  through xterm.js; it can differ from the real terminal in wrapping/glyphs.
  Assert on the text grid, never on the render.
- **Prerequisites.** The v2 engine (\`opencode2\`) and \`tmux\` are required. A
  browser is **optional** and never bundled — with none the browser checks SKIP
  cleanly (gate on \`handle.browser.available\`); install one or set \`CHROME_PATH\`
  to run them.
- **Isolation is bounded.** Engine, proxy, cwd, ports, and extension dir are
  isolated and the harness never touches the production webui/engine — but it
  does run real engine/browser/tmux processes on the host.

## Source catalog (fetch, don't read a local checkout)

| File | Purpose |
| --- | --- |
| ${RAW("docs/runbooks/agent-testing.md")} | The full runbook — harness API, isolation model, gotchas |
| ${RAW("scripts/testkit/harness.ts")} | \`start()\`, the API client, \`Reporter\`, \`expect\`, \`waitFor\`, isolation helpers |
| ${RAW("scripts/testkit/browser.ts")} | Browser resolution — points at the environment's browser; never bundles one |
| ${RAW("scripts/testkit/ui.ts")} | The real-Chromium driver (optional; FAILS SOFT without a browser) |
| ${RAW("scripts/testkit/tui.ts")} | The real tmux + \`opencode\` driver (\`renderPng()\` needs a browser; the text grid does not) |
| ${RAW("scripts/testkit/example.test.ts")} | The worked example |
| ${RAW("scripts/testkit/fixtures/testkit-echo/manifest.json")} | The four-strata fixture (\`manifest.json\` + \`index.tsx\`/\`dom.ts\`/\`server.ts\`/\`engine/\`) |
`;

mkdirSync(dirname(TESTKIT_TARGET), { recursive: true });
writeFileSync(TESTKIT_TARGET, testkitSkill);
console.log(`[gen-skill] wrote ${TESTKIT_TARGET} (${testkitSkill.length} bytes, description ${TESTKIT_DESCRIPTION.length} chars)`);
