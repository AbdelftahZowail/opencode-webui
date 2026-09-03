// webui-engine-fixture — verified minimal engine-plugin fixture.
//
// ONE tools.* tool returning {output}, ONE {type:"text"} system hint, nothing
// else. This is the smallest payload that exercises the full engine seam the
// guide documents (docs/engine-payload-convention.md + webui-extensions
// README engine section):
//
//   - v2 export shape: module.exports = { id, setup } (the v1 {server} /
//     named-export shape is rejected by the loader at boot).
//   - Tool namespace: registered bare (`webui_fixture_ping`); the model
//     lists it as `tools.webui_fixture_ping`.
//   - Tool results resolve `{ output }` — a bare string fails validation.
//   - System-hint parts are `{ type: "text", text }` — a bare {text} fails
//     the whole session drain.
//
// Proven by scripts/uitest/engine-probe.ts against an isolated probe engine.
// Test-only fixture: never shipped, never referenced by src/ or server/.

const TOOL_NAME = "webui_fixture_ping";

const SYSTEM_HINT =
  "WebUI engine fixture: the `tools.webui_fixture_ping` tool echoes its input for seam verification.";

const OUTPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: true };

async function setup(api) {
  // System hint via the session context hook (same shape the builtin prompt
  // plugins splice in: { type: "text", text }).
  try {
    await api.session.hook("context", (m) => {
      try {
        if (m && Array.isArray(m.system)) m.system.push({ type: "text", text: SYSTEM_HINT });
      } catch {
        /* hint is best-effort */
      }
    });
  } catch {
    /* older engines without session.hook: the tool still works */
  }

  await api.tool.transform((tools) => {
    tools.add({
      name: TOOL_NAME,
      description: "Echo its input back — engine-seam verification fixture (no side effects).",
      input: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to echo back." },
        },
        required: [],
        additionalProperties: false,
      },
      output: OUTPUT_SCHEMA,
      execute: async (args) => {
        const text = args && typeof args.text === "string" ? args.text : "";
        return { output: `pong: ${text}` };
      },
    });
  });

  return undefined;
}

module.exports = { id: "webui-engine-fixture", setup };
