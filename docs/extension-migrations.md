# Extension migrations — DSH → webui

Status: **spec, not yet implemented**. Three extensions to port from the DeepSeek
Harness (`~/.dsh/profiles/web/user-plugins/`) into this repo's v2 extension system
(one folder per extension — see `docs/extension-system-spec.md` §4 and
`webui-extensions/README.md`). Behavioral spec only: the implementing agent chooses
mechanisms, but must honor the contracts named here and the standing rules in
`AGENTS.md` ("How to change the webui without breaking extensibility").

General rules for all three:

- These specs were reverse-specified from working DSH plugins, and DSH's host API
  is not opencode v2's API. Where the engine surfaces differ (session lifecycle,
  history shape, tool registration, settings namespaces), the port must
  add, drop, or reshape behavior to fit what opencode v2 actually exposes —
  faithfulness is to the user-visible behavior, not to the DSH internals.
  Anything that cannot be expressed on v2 is cut and noted in the commit, not
  worked around with private engine knowledge.

- Ship as folders under `webui-extensions/<name>/` with `manifest.json` + the strata
  each one needs. No core edits except where explicitly allowed below (new leaf
  targets / service ids, which are additive and therefore safe).
- Engine payloads (`engine/`) follow `docs/engine-payload-convention.md` — the webui
  never loads them; they must work as standalone opencode plugins.
- Before/after proof for each: `docs/extension-timestamp-test.md` is the template —
  record baseline behavior, apply, confirm, uninstall cleanly.

---

## 1. Brother agent (`webui-extensions/brother-agent/`)

**Source material:** `~/.dsh/profiles/web/user-plugins/brother-agent-live4/`
(`lib/definitions.cjs` — all tool logic; `lib/index.js` — self-reloading shell pattern)
and `~/.dsh/profiles/web/user-plugins/brother-watcher3/` (finish-notice poller).

**What it is:** the escape hatch for work too big for a sub-agent. A *brother* is a
fresh, clean-context top-level agent session with the full toolset — it plans and
spawns its own sub-agents — driven by the parent through tools instead of the
leaf-only `subagent` path.

**Behavior (must preserve from the DSH original):**

- `brother_agent` takes a self-contained `{ task, cwd?, provider?, model?,
  waitForFinish?, timeoutMs?, returnLastOnly? }`. It creates an isolated session
  (in the launcher's workspace by default), sends the task as its first message, and
  returns the new session id plus running state. With `waitForFinish` it blocks
  (default cap 10 minutes) and returns the result — full transcript or last output
  only, per `returnLastOnly`.
- Companions: `status` (running/finished + title/age/turn stats), `read` (clean
  plain-text transcript — user/assistant text only, thinking and tool calls opt-in),
  `message` (queue behind current work), `steer` (join at the next step boundary;
  `interrupt: true` stops the turn first), `stop`, `archive`, `list` (with
  origin/status filters), `watch` (notify a parent session when watched sessions
  settle, including an "all N finished" notice).
- Model choice: explicit per-call `provider`/`model` wins; otherwise a configured
  brother default applies; otherwise inherit the parent's model. Never clobber the
  user's session default.
- Completion notices must reach the parent even with all browser tabs closed
  (headless watcher), with the same next-turn semantics as native subagent notices.

**Strata:** `engine/` registers the model-callable tools; `server.ts` owns the
headless watch/notify loop and completion queueing (KV for the watch list, replacing
`~/.dsh/brother-watches.json`); `index.tsx` is a thin browser half (sidebar badge /
session-origin label only). Session-origin tagging (`brother-agent` vs `user`)
should survive as queryable metadata for the `list` filters.

**Agent discoverability:** the model must know this exists. The `engine/` half carries
a short system-prompt hint (via `experimental.chat.system.transform`): when a task is
LARGE, delegate via `brother_agent` with a self-contained prompt. Keep it to a few
lines — the tool descriptions carry the detail.

**Acceptance:** launch a brother on a task that itself needs subagents; confirm it
plans and delegates; `status`/`read` mid-run; `steer` redirects without killing work;
`stop` aborts; closing every tab still delivers the finish notice; uninstalling the
folder removes tools and UI with no residue. Before any agent testing, probe
that the configured model actually answers —
`POST /session/{id}/generate {"prompt":"OK"}` must return text, otherwise a
rotted default model id fails the run blank and the failure looks like the
extension's fault.

---

## 2. Rich render (`webui-extensions/rich-render/`)

**Source material:** `~/.dsh/profiles/web/user-plugins/rich-render/lib/client.js`
(full behavior + CSS; ~630 lines, well-commented — read it first).

**What it is:** Claude-style inline visuals in chat messages. Three mechanisms,
deliberately distinct — preserve all three and their separation:

1. **Backtick code blocks stay code-only.** Never live-rendered. The webui already
   styles these via `MessageItem`'s markdown pipeline — only fill genuine styling
   gaps, don't rebuild the pipeline.
2. **Tilde fences render LIVE.** `~~~html`, `~~~live-html`, `~~~live-js`,
   `~~~svg`/`~~~live-svg`, `~~~pdf`/`~~~live-pdf`, `~~~image`/`~~~live-image`
   (full tag table at source `LIVE_KINDS`). HTML/SVG/JS mount in a sandboxed iframe
   (`sandbox="allow-scripts"`, opaque origin, strict CSP allowlisting inline
   scripts/styles plus the two common CDNs and nothing else — source `LIVE_CSP`);
   PDF/image fences take a single URL (`http(s)` or `data:`) and render the viewer
   or image. Local file paths must degrade to a clear note, never a broken frame.
   Toolbar per live block: live/code toggle, copy source, reload, open in new tab.
   Content mounts only when settled — never mid-stream.
3. **Images and PDFs inline.** Message images get sane inline styling; `.pdf` links
   get an inline Preview toggle card. The webui already handles `data:` images and
   attachment thumbnails — extend, don't duplicate.

**Rules carried over:** never remove or re-parent React-owned nodes (sibling
injection + hiding only, with cleanup when React drops the anchor); backticks are
NEVER live; streaming content never mounts live output.

**Strata:** mostly browser (`wrap` on the markdown/message targets) + `dom.ts` where
the tree can't reach (iframes, post-render frames). `engine/` carries ONLY the
syntax hint so the model knows the `~~~` fences exist (same `system.transform`
mechanism as brother-agent, a few lines). Rendering decisions stay browser-side.

**Acceptance:** ```` fences render as code; `~~~html` renders isolated output with a
working Show-code toggle; a `~~~live-pdf` URL shows the viewer; a local path shows
the note; streaming a fence shows code until settled; switching sessions leaks no
nodes; uninstall restores stock rendering exactly.

---

## 3. Groq voice (`webui-extensions/groq-voice/`)

**Source material:** `~/.dsh/profiles/web/user-plugins/groq-voice/lib/client.js`
(full behavior incl. error taxonomy and settings UI; ~590 lines — read it first).

**What it is:** a mic button next to Send in the composer. Click to record
(`getUserMedia` + `MediaRecorder`, best-supported mime first), click again to stop;
audio goes to Groq `whisper-large-v3-turbo` directly from the browser; the transcript
is appended to the composer draft (space-joined onto existing text) and the composer
regains focus.

**Behavior (must preserve):**

- Hard auto-stop at 2 minutes; live elapsed timer while recording; transient status
  line (recording / transcribing / ok / error, auto-clearing).
- API key settings section with Save + Test-key (validated against Groq's models
  endpoint), persisted in `localStorage` under the existing `groq-voice.apiKey`
  key so current users keep their keys. The key goes only to `api.groq.com` —
  state this in the settings copy.
- The full error taxonomy: mic denied / no mic / mic busy / missing key / empty
  transcript / HTTP 401/403/404/413/429 with per-case guidance / network failure.
  Every failure surfaces as a status line, never a silent drop.
- Teardown on unmount (session switch, disable): stop recorder, release tracks,
  clear status. A hot edit or disable mid-recording must not leak the mic.

**Strata:** browser only. No engine half, no system hint — the model needs to know
nothing. If core lacks a fine-grained target at the Send-button row, adding a leaf
target is the allowed core change (additive, per `AGENTS.md` rule 3).

**Acceptance:** record → transcript lands in the draft with existing text preserved;
2-minute cap auto-sends; each error case shows its message; key survives reload;
uninstalled mid-record releases the mic; the page never sends the key anywhere but
Groq.
