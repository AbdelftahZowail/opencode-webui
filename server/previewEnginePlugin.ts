/**
 * The core inline-preview OpenCode engine plugin, shipped as source.
 *
 * The webui renders `~~~lang` fences as live inline previews (see
 * `src/components/markdown/fence.ts` + `PreviewBlock.tsx`), but nothing told the
 * MODEL that the convention exists — so the feature went unused. This payload is
 * the missing half: a system hint that teaches the tilde-fence syntax and its
 * safety rules (backticks stay code; never put secrets in a live block).
 *
 * Same reasoning as `lifecyclePlugin.ts` / `shelfEnginePlugin.ts`: embedding the
 * source as a string makes an npm package (a real `server/` directory) and a
 * `bun build --compile` binary (no real filesystem) one code path.
 *
 * Install story (wired by `server/setup.ts`): written to
 * `<config>/opencode/plugins/opencode-webui-preview/`, marker-gated so an
 * unrelated directory is never clobbered, and removed by `opencode-webui
 * uninstall` like the other two. `WEBUI_NO_PLUGIN=1` skips all three.
 *
 * Hint-only — no tools. The source deliberately avoids template literals and
 * `${}` so it can live in this TS template verbatim.
 */

export const PREVIEW_ENGINE_PLUGIN_ID = "opencode-webui-preview";

export const PREVIEW_ENGINE_PLUGIN_SOURCE = `// opencode-webui inline-preview plugin
//
// Managed by opencode-webui — do not edit. (Re)written on every webui boot and
// removed by \`opencode-webui uninstall\`.
//
// Teaches the model the webui's tilde-fence (~~~) live-preview convention: a
// ~~~html / ~~~svg / ~~~pdf / ~~~image fence renders INLINE in the chat, while
// a backtick fence always stays code. No tools — hint only.

const ID = "opencode-webui-preview";

function systemHint() {
  return [
    "Rich inline rendering (webui): when a small visual helps — a mockup, a",
    "diagram, a styled snippet — emit a TILDE fence and it renders live inline:",
    "~~~html / ~~~svg for markup (full documents also fine), ~~~pdf / ~~~image",
    "with a single http(s) or data: URL on the first line for viewers. Backtick",
    "(\`\`\`) fences always stay code — never use them for output meant to be seen",
    "rendered. Keep live blocks small, dependency-free (inline scripts/styles",
    "only), and never put secrets in them.",
  ].join("\\n");
}

async function setup(api) {
  try {
    if (api && api.session && typeof api.session.hook === "function") {
      var HINT = systemHint();
      await api.session.hook("context", function (m) {
        try {
          if (m && Array.isArray(m.system)) m.system.push({ type: "text", text: HINT });
        } catch (err) { /* hint is best-effort */ }
      });
    }
  } catch (err) { /* older engines without session.hook: nothing else to do */ }
  return undefined;
}

module.exports = { id: ID, setup };
`;

export const PREVIEW_ENGINE_PLUGIN_PACKAGE_JSON = `{
  "name": "opencode-webui-preview",
  "private": true,
  "main": "index.js",
  "description": "Inline-preview system hint (tilde fences) for opencode-webui. Managed by opencode-webui."
}
`;
