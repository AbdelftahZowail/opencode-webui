# brother-agent port — status: what was done and what's left

Date: 2026-09-03. Folder: `webui-extensions/brother-agent/` (recreated from scratch after operator deletion; final tree is fully my own work — see §5).

## 1. What was built

- `manifest.json` — id `brother-agent`, v1.0.0.
- `engine/index.js` (stable shell): registers 9 fixed tool schemas via `tool.transform`, hot-reloads logic from `definitions.cjs` (require-cache bust on mtime, no engine restart for logic edits). System hint via `session.hook("context")` pushing `{type:"text", text}`. Exports `{id, setup}` (v2 shape — the v1 `{server}` / named-export shape is rejected by the loader).
- `engine/definitions.cjs` (all tool logic): `brother_agent` (launch + `waitForFinish`), `status`, `read`, `message` (queue), `steer` (steer / interrupt+steer), `stop` (interrupt), `archive` (DELETE session), `list` (origin/status filters), `watch` (seam-file append). Origin = native session `metadata: {origin:"brother-agent"}` at create (REST create when discoverable, else setup create — setup bridge drops metadata). Model: explicit > `~/.config/opencode/brother-agent.json` > parent inherit > engine default, passed at create (no default-clobber dance). Watches: append/prune-only seam file `$XDG_STATE_HOME/opencode-webui/brother-watches.json`.
- `server.ts` (proxy stratum): 3s poller + `onEvent` kick; reads seam, checks `/api/session/active`, queues finish + "all N finished" notices via `POST /session/{parent}/prompt` (`delivery:"queue"`); delivery state in ext KV (`notified`), deletes delivered seam entries (KV authoritative on races). Route `GET /api/webui/ext/brother-agent/brothers` for the browser half. No core imports (node builtins only). Engine discovery via `$XDG_STATE_HOME/opencode/service.json` (Basic opencode:password), read-only.
- `index.tsx` (browser, thin): wraps `sidebar.sessionRow` (brother badge) + `conversation.header` (origin ribbon), flow-through; data = proxy `brothers` route + adopted session's native metadata; 30s refresh + `session.adopted` hook.

v2 reshapes (faithful to user-visible behavior): model passed at create; stats = tokens+cost only; `archive` = session removal; no `reasoningEffort` arg (use `variant`); no blank-state; REST fallbacks degrade gracefully when undiscoverable.

## 2. Verification evidence (isolated sandbox)

- `bun run typecheck` green.
- Engine probe server (`/tmp/opencode/bro-probe`, port 49499, plugin = this `engine/`): `/api/plugin` → `brother-agent | active`. Model listed 9 tools as `tools.brother_agent*` with correct required params.
- `status` mid-run via model: `session … — running, title, updated, tokens, origin: brother-agent`. `read lastOnly` returned the launch task text.
- Launch: lighthouse story (`ses_f9b1eb18…`, metadata `origin:brother-agent`, parent cwd inherited), travelogue, sketches (8/8 files), village (12/12), novel child (`ses_f9b0a727c…`). Finish notices delivered headless (no browser open; proxy poller only): `[brother-agent] … finished … — and that was the last one: all 1 …`, seam entry consumed, KV `notified` set.
- `steer` (no interrupt) → `steer sent … (no interrupt — joins at the next step boundary)`; `stop` → `stop requested … (interrupted: true)`, child left active set.
- Sandbox proxy (`XDG_STATE_HOME=/tmp/opencode/bro-state`, `WEBUI_EXTENSION_DIR=/tmp/opencode/bro-ext`, auto ports UI :42669/proxy :36163): `server extension loaded: brother-agent`; `GET /api/webui/ext/brother-agent/brothers` OK.
- Two live bugfixes from evidence: tool results must be `{output}` objects (bare string fails result validation: `Unknown tool`, `'"output"in J'`); system-hook parts need `{type:"text"}` or the whole drain fails schema validation; setup-bridge create drops `metadata` → switched to REST create when discoverable.

## 3. What's left / not yet proven

1. **Uninstall test** — delete folder, confirm tools + UI gone with no residue. Not run.
2. **`waitForFinish:true` end-to-end** — model declined the 15k-word single-shot (correctly); the blocking path (REST `active` poll / setup `wait` fallback) is untested live.
3. **`archive`, `list`, `watch` (manual) via model** — implemented, not exercised end-to-end (list only via direct REST; archive DELETE untested; manual watch + aggregate "all N" notice untested).
4. **Explicit `provider`/`model` launch** — resolution order implemented, no live launch on a non-default model.
5. **Brother-plans-and-delegates** — novel child delegated once (`Delegating your 12-chapter novel…`); deeper subagent-tree proof is thin.
6. **Tabs-closed proof** — notices arrived with no browser attached (proxy-only), which is the substance, but no open-then-close-tabs run was done.
7. **Sibling folders** — `groq-voice/`, `rich-render/` untouched (only copied `brother-agent/` to `/tmp/opencode/bro-ext`).
8. **Friction log + cut list** — required for the final report; drafted in working notes, not yet written up.
9. **Test-loop hygiene** — kill stray probe servers (`serve --port 49499`), remove `/tmp/opencode/bro-probe`, `/tmp/opencode/bro-ext`, `/tmp/opencode/bro-{state,data}` scratch (kept for now for continued testing).

## 4. Cut list (so far)

- `reasoningEffort` arg → `variant` (v2 model ref shape).
- Turn/step/llmMs/decodeTokens stats → tokens in/out + cost (all v2 exposes).
- Blank-session state (no v2 equivalent).
- Archive-as-hide → archive-as-remove (v2 has session DELETE, no archive endpoint); no unarchive.
- `~/.dsh/session-origins.json` + 30-day prune → native session metadata (lives/dies with session); seam file kept only for watch linkage.

## 5. Tree-integrity confirmation

`webui-extensions/brother-agent/` contains only my files (`manifest.json`, `engine/index.js`, `engine/definitions.cjs`, `server.ts`, `index.tsx` — plus this status file). `groq-voice/` and `rich-render/` were not touched. Typecheck green at time of writing.
