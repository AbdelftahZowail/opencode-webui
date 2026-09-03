/**
 * rich-render engine payload — SYNTAX HINT ONLY (no tools).
 *
 * Loaded by the ENGINE under opencode plugin rules (boot-time load, restart
 * on edit), never by the webui. Registration is the user's: point the engine
 * at this folder (e.g. the opencode plugin config). Rendering decisions stay
 * browser-side (index.tsx + dom.ts); this file only teaches the model that
 * the ~~~ fences exist so it reaches for them when inline visuals help.
 *
 * NOTE: the hook shape below follows the engine's plugin convention
 * (`experimental.chat.system.transform` appending to the system prompt, same
 * mechanism as brother-agent). If the running engine renames that seam,
 * update the key — the HINT text is the stable part.
 */

const HINT = [
  "Rich inline rendering (webui): when a small visual helps — a mockup, a",
  "diagram, a styled snippet — emit a TILDE fence and it renders live inline:",
  "~~~html / ~~~svg for markup (full documents also fine), ~~~pdf / ~~~image",
  "with a single http(s) or data: URL on the first line for viewers. Backtick",
  "(```) fences always stay code — never use them for output meant to be seen",
  "rendered. Keep live blocks small, dependency-free (inline scripts/styles",
  "only), and never put secrets in them.",
].join("\n");

/**
 * @param _input plugin input (unused — this payload needs no client/shell)
 */
export default async function init(_input) {
  return {
    "experimental.chat.system.transform": async (_tinput, output) => {
      try {
        if (output && Array.isArray(output.system)) output.system.push(HINT);
      } catch {
        /* never break the system prompt */
      }
    },
  };
}
