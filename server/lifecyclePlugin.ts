/**
 * The built-in OpenCode lifecycle plugin, shipped as source.
 *
 * Why a string and not a real file: this must install identically from an npm
 * package (a real `plugin/` directory) AND from a `bun build --compile`
 * executable (no real filesystem). Embedding the source as a string makes both
 * paths one code path with no extra embed machinery.
 *
 * Installed to `<opencode config>/plugins/opencode-webui/` — a directory the
 * engine auto-discovers globally (V2 plugin discovery). Its `setup()` runs when
 * OpenCode activates the location's plugins (verified: the engine does this
 * lazily, on first use — not at raw daemon boot), and starts the webui proxy
 * detached. It reads the launch command the webui keeps fresh in
 * `~/.local/state/opencode-webui/launch.json` and never blocks the engine.
 *
 * CommonJS `module.exports = { id, setup }`, matching the proven local-engine
 * shape (webui-extensions/brother-agent/engine/index.js). The source avoids
 * template literals on purpose so it can live in this TS template verbatim.
 */

export const LIFECYCLE_PLUGIN_ID = "opencode-webui";

export const LIFECYCLE_PLUGIN_SOURCE = `// opencode-webui lifecycle plugin
//
// Managed by opencode-webui — do not edit. This file is (re)written on every
// webui boot and removed by \`opencode-webui uninstall\`.
//
// Job: when OpenCode activates this location's plugins (i.e. as soon as you
// use OpenCode), start the opencode-webui proxy in the background if it is not
// already serving. Fire-and-forget: the engine must never wait on it, and the
// proxy outlives the engine (detached + unref).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVICE = "opencode-webui";
let started = false;

function stateDir() {
  const base =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, SERVICE);
}

// The webui writes launch.json on every boot; it is the stable handoff.
function readLaunch() {
  try {
    const raw = fs.readFileSync(path.join(stateDir(), "launch.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.cmd) && parsed.cmd.length > 0) {
      return { cmd: parsed.cmd, port: Number(parsed.port) || 0 };
    }
  } catch (err) {
    /* fall through to wrapper discovery */
  }
  const candidates = [];
  if (process.env.WEBUI_BIN_DIR) {
    candidates.push(path.join(process.env.WEBUI_BIN_DIR, SERVICE));
  }
  candidates.push(path.join(os.homedir(), ".local", "bin", SERVICE));
  candidates.push(path.join(os.homedir(), ".bun", "bin", SERVICE));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { cmd: [candidate], port: 0 };
    } catch (err) {
      /* keep looking */
    }
  }
  return null;
}

async function alreadyRunning(port) {
  if (!port) return false;
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/login", {
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    return (await res.text()).includes("opencode webui");
  } catch (err) {
    return false;
  }
}

module.exports = {
  id: SERVICE,
  async setup() {
    if (started) return;
    if (process.env.WEBUI_NO_PLUGIN === "1") return;
    const launch = readLaunch();
    if (!launch) return;
    if (await alreadyRunning(launch.port)) return;
    started = true;
    try {
      const child = spawn(launch.cmd[0], launch.cmd.slice(1), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: Object.assign({}, process.env, { WEBUI_SPAWNED_BY: "opencode-plugin" }),
      });
      child.unref();
    } catch (err) {
      started = false;
    }
  },
};
`;

export const LIFECYCLE_PLUGIN_PACKAGE_JSON = `{
  "name": "opencode-webui-lifecycle",
  "private": true,
  "main": "index.js",
  "description": "Starts the opencode-webui proxy when the OpenCode engine loads. Managed by opencode-webui."
}
`;
