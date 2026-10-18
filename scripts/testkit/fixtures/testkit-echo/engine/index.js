// testkit-echo — engine stratum (fixture): an opencode plugin payload.
//
// The v2 export shape and the two hard-won contracts the guide documents:
//   - module.exports = { id, setup }
//   - tool results resolve { output: string } (a bare string fails validation)
//   - system-hint parts are { type: "text", text }
//
// The engine plugin id MUST match the extension folder id (`testkit-echo`) so
// the harness can wait on GET /api/plugin by id after an install.
//
// Test-only fixture: never shipped, never referenced by src/ or server/.

const TOOL_NAME = "webui_testkit_echo";

const SYSTEM_HINT =
  "Testkit fixture: the `tools.webui_testkit_echo` tool echoes its input back.";

async function setup(api) {
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
      description: "Echo its input back — harness fixture (no side effects).",
      input: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo." } },
        required: [],
        additionalProperties: false,
      },
      output: { type: "object", properties: {}, additionalProperties: true },
      execute: async (args) => {
        const text = args && typeof args.text === "string" ? args.text : "";
        return { output: `testkit-echo: ${text}` };
      },
    });
  });

  return undefined;
}

module.exports = { id: "testkit-echo", setup };
