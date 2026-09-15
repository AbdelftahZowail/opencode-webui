#!/usr/bin/env bun
/**
 * First-run setup contract check — the global command, the OpenCode lifecycle
 * plugin, the launch handoff, and the `update`/`uninstall` CLI. No real install:
 * every write is redirected to a throwaway HOME/XDG tree, and only the hidden
 * `internal:setup` handoff is exercised (never `update`, which would hit the
 * network).
 *
 *   bun run check:setup
 *
 * Exit 0 = all checks pass; 1 = at least one FAIL.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureSetup,
  readLaunchConfig,
  renderWrapper,
  resolveLaunchCommand,
  runSetupCli,
  setupStatus,
  stabilizeEntryUrl,
  uninstallSetup,
} from "../../server/setup";
import {
  LIFECYCLE_PLUGIN_PACKAGE_JSON,
  LIFECYCLE_PLUGIN_SOURCE,
} from "../../server/lifecyclePlugin";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type EnvOverrides = Record<string, string | undefined>;
async function withEnv(overrides: EnvOverrides, fn: () => void | Promise<void>): Promise<void> {
  const keys = Object.keys(overrides);
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// resolveLaunchCommand — compiled binary vs bun/bunx
// ---------------------------------------------------------------------------
{
  const compiled = resolveLaunchCommand("file:///$bunfs/root/opencode-webui-linux-x64");
  check("compiled: launches process.execPath only", compiled.cmd.length === 1 && compiled.cmd[0] === process.execPath, compiled.cmd.join(" "));
  const plain = resolveLaunchCommand("file:///opt/app/server/index.ts");
  check("bun: execPath + absolute script", plain.cmd[0] === process.execPath && plain.cmd[1] === "/opt/app/server/index.ts", plain.cmd.join(" "));
  const spacey = resolveLaunchCommand("file:///opt/my%20app/server/index.ts");
  check("url with spaces is decoded", spacey.cmd[1] === "/opt/my app/server/index.ts", spacey.cmd[1] ?? "(none)");
}

// ---------------------------------------------------------------------------
// bunx installs are mirrored to a stable entry
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "webui-bunx-mirror-"));
  const state = join(tmp, "state");
  const install = join(tmp, "bunx-1000-opencode-webui@9.9.9");
  const entry = join(install, "node_modules", "opencode-webui", "server", "index.ts");
  const dep = join(install, "node_modules", "@opencode", "client", "index.js");
  const bin = join(install, "node_modules", ".bin", "opencode-webui");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(dirname(dep), { recursive: true });
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(entry, "// entry\n");
  writeFileSync(dep, "// dep\n");
  symlinkSync(join("..", "opencode-webui", "server", "index.ts"), bin);

  const mirrored = join(state, "opencode-webui", "entry", "9.9.9", "node_modules");
  await withEnv({ XDG_STATE_HOME: state, HOME: tmp }, () => {
    const outside = join(tmp, "app", "server", "index.ts");
    const untouched = stabilizeEntryUrl(pathToFileURL(outside).href, "9.9.9", tmp);
    check("stable entry: a non-bunx path is left alone", untouched.url === pathToFileURL(outside).href && !untouched.detail);

    const stable = stabilizeEntryUrl(pathToFileURL(entry).href, "9.9.9", tmp);
    const expected = join(mirrored, "opencode-webui", "server", "index.ts");
    check("stable entry: bunx install mirrored under the state dir", stable.url === pathToFileURL(expected).href, stable.url);
    check("stable entry: mirrored file carries the entry", existsSync(expected) && readFileSync(expected, "utf8") === "// entry\n");
    check("stable entry: dependencies are mirrored too", existsSync(join(mirrored, "@opencode", "client", "index.js")));
    check("stable entry: symlinks stay symlinks", readlinkSync(join(mirrored, ".bin", "opencode-webui")) === join("..", "opencode-webui", "server", "index.ts"));
    check("stable entry: launch command uses the mirror", resolveLaunchCommand(stable.url).cmd[1] === expected);

    // The whole point: the temp install can vanish and launches still work.
    rmSync(install, { recursive: true, force: true });
    const again = stabilizeEntryUrl(pathToFileURL(entry).href, "9.9.9", tmp);
    check("stable entry: survives the temp install being wiped", again.url === pathToFileURL(expected).href && existsSync(expected));
  });
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// wrapper rendering
// ---------------------------------------------------------------------------
{
  const w = renderWrapper(["/usr/bin/bun", "/a b/index.ts"], false);
  check("posix wrapper: shebang", w.startsWith("#!/bin/sh\n"));
  check("posix wrapper: managed marker", w.includes("managed by opencode-webui"));
  check("posix wrapper: exec with quoted args", w.includes("exec '/usr/bin/bun' '/a b/index.ts' \"$@\""));
  check("posix wrapper: ends with newline", w.endsWith("\n"));

  const win = renderWrapper(["C:\\bun.exe", "C:\\a b\\index.ts"], true);
  check("windows wrapper: CRLF", win.includes("\r\n"));
  check("windows wrapper: forwards %*", win.includes("%*"));
  check("windows wrapper: quoted program", win.includes('"C:\\bun.exe" "C:\\a b\\index.ts"'));
}

// ---------------------------------------------------------------------------
// lifecycle plugin source
// ---------------------------------------------------------------------------
{
  let parses = true;
  try {
    // Parse only — never run (it requires engine-provided globals).
    new Function("module", "exports", "require", "__dirname", LIFECYCLE_PLUGIN_SOURCE);
  } catch {
    parses = false;
  }
  check("plugin: source parses as a CJS module", parses);
  check("plugin: exports { id, setup }", LIFECYCLE_PLUGIN_SOURCE.includes("id: SERVICE") && LIFECYCLE_PLUGIN_SOURCE.includes("async setup()"));
  check("plugin: detaches the child", LIFECYCLE_PLUGIN_SOURCE.includes("detached: true") && LIFECYCLE_PLUGIN_SOURCE.includes("child.unref()"));
  check("plugin: reads the launch handoff", LIFECYCLE_PLUGIN_SOURCE.includes("launch.json"));
  check("plugin: no `${` leaked from the TS template", !LIFECYCLE_PLUGIN_SOURCE.includes("${"));
  check("plugin: package.json is valid JSON", (() => {
    try {
      JSON.parse(LIFECYCLE_PLUGIN_PACKAGE_JSON);
      return true;
    } catch {
      return false;
    }
  })());
}

// ---------------------------------------------------------------------------
// the plugin actually runs: setup() spawns the launch command detached
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "webui-plugin-run-"));
  const state = join(tmp, "state");
  mkdirSync(join(state, "opencode-webui"), { recursive: true });
  const spawned = join(tmp, "spawned.txt");
  writeFileSync(
    join(state, "opencode-webui", "launch.json"),
    JSON.stringify({ cmd: ["/bin/sh", "-c", `printf spawned > '${spawned}'`], port: 0 }),
  );
  const savedState = process.env.XDG_STATE_HOME;
  const savedHome = process.env.HOME;
  const savedNoPlugin = process.env.WEBUI_NO_PLUGIN;
  process.env.XDG_STATE_HOME = state;
  process.env.HOME = tmp;
  delete process.env.WEBUI_NO_PLUGIN;
  try {
    const requireShim = createRequire(import.meta.url);
    const mod: { exports: { id?: string; setup?: () => Promise<void> } } = { exports: {} };
    new Function("module", "exports", "require", "__dirname", LIFECYCLE_PLUGIN_SOURCE)(
      mod,
      mod.exports,
      requireShim,
      tmp,
    );
    check("plugin: evaluates to { id, setup }", mod.exports.id === "opencode-webui" && typeof mod.exports.setup === "function");
    await mod.exports.setup?.();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !existsSync(spawned)) Bun.sleepSync(50);
    check("plugin: setup spawns the launch command detached", existsSync(spawned), spawned);
  } finally {
    if (savedState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedState;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedNoPlugin === undefined) delete process.env.WEBUI_NO_PLUGIN;
    else process.env.WEBUI_NO_PLUGIN = savedNoPlugin;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// install / idempotency / uninstall — isolated in-process
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "webui-setup-check-"));
  const config = join(tmp, "config");
  const state = join(tmp, "state");
  const bin = join(tmp, "bin");
  const bunx = mkdtempSync(join(tmpdir(), "bunx-uitest-"));
  const bunxEntry = join(bunx, "node_modules", "opencode-webui", "server", "index.ts");
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(bunxEntry), { recursive: true });
  writeFileSync(bunxEntry, "// entry\n");
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: state,
        HOME: tmp,
        WEBUI_BIN_DIR: bin,
        WEBUI_NO_SETUP: undefined,
        WEBUI_NO_PLUGIN: undefined,
        WEBUI_SANDBOX: undefined,
      },
      async () => {
        const wrapper = join(bin, "opencode-webui");
        const pluginIndex = join(config, "opencode", "plugins", "opencode-webui", "index.js");
        const launch = join(state, "opencode-webui", "launch.json");

        const res = ensureSetup({ entryUrl: "file:///opt/app/server/index.ts", port: 4097, version: "9.9.9", force: true, quiet: true });
        check("install: first run installed", res.status === "installed", res.status);
        check("install: wrapper written", existsSync(wrapper), wrapper);
        check("install: wrapper execs the entry", readFileSync(wrapper, "utf8").includes("/opt/app/server/index.ts"));
        check("install: plugin written verbatim", existsSync(pluginIndex) && readFileSync(pluginIndex, "utf8") === LIFECYCLE_PLUGIN_SOURCE);
        check("install: launch handoff written", readLaunchConfig()?.version === "9.9.9" && readLaunchConfig()?.port === 4097);
        check("install: status reports present", setupStatus().wrapperPresent && setupStatus().pluginPresent);

        const again = ensureSetup({ entryUrl: "file:///opt/app/server/index.ts", port: 4097, version: "9.9.9", force: true, quiet: true });
        check("idempotent: second run is a no-op", again.status === "present", again.status);

        // A bunx install must never be baked into the wrapper / launch handoff.
        ensureSetup({ entryUrl: pathToFileURL(bunxEntry).href, port: 4097, version: "9.9.9", force: true, quiet: true });
        const mirrorEntry = join(state, "opencode-webui", "entry", "9.9.9", "node_modules", "opencode-webui", "server", "index.ts");
        check("bunx: setup launches the stable mirror, not the temp path", readLaunchConfig()?.cmd[1] === mirrorEntry && readFileSync(wrapper, "utf8").includes(mirrorEntry), readLaunchConfig()?.cmd.join(" ") ?? "(none)");
        rmSync(bunx, { recursive: true, force: true });
        check("bunx: mirror survives the temp dir being wiped", existsSync(mirrorEntry));

        const un = uninstallSetup();
        check("uninstall: removed wrapper + plugin", un.removed.includes(wrapper) && un.removed.includes(join(config, "opencode", "plugins", "opencode-webui")));
        check("uninstall: files gone", !existsSync(wrapper) && !existsSync(pluginIndex) && !existsSync(launch));
        check("uninstall: mirror gone", !existsSync(join(state, "opencode-webui", "entry")));
        check("uninstall: decline recorded", setupStatus().declined);

        await runSetupCli("setup", "file:///opt/app/server/index.ts");
        check("setup: re-enables after uninstall", existsSync(wrapper) && existsSync(pluginIndex) && !setupStatus().declined);
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(bunx, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// foreign files are never clobbered
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "webui-setup-foreign-"));
  const config = join(tmp, "config");
  const state = join(tmp, "state");
  const bin = join(tmp, "bin");
  mkdirSync(join(config, "opencode", "plugins", "opencode-webui"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  try {
    const foreign = join(bin, "opencode-webui");
    Bun.write(foreign, "#!/bin/sh\necho not ours\n");
    Bun.write(join(config, "opencode", "plugins", "opencode-webui", "index.js"), "// someone else\n");
    await withEnv(
      { XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, HOME: tmp, WEBUI_BIN_DIR: bin },
      () => {
        ensureSetup({ entryUrl: "file:///opt/app/server/index.ts", port: 4097, version: "9.9.9", force: true, quiet: true });
        check("foreign: wrapper untouched", readFileSync(foreign, "utf8").includes("not ours"));
        check("foreign: plugin untouched", readFileSync(join(config, "opencode", "plugins", "opencode-webui", "index.js"), "utf8").includes("someone else"));
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI — hidden handoff, status, help (children, isolated env)
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "webui-setup-cli-"));
  const config = join(tmp, "config");
  const state = join(tmp, "state");
  const bin = join(tmp, "bin");
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const childEnv = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    HOME: tmp,
    WEBUI_BIN_DIR: bin,
  } as Record<string, string>;
  const run = (action: string) =>
    Bun.spawnSync(["bun", "server/index.ts", action], { cwd: ROOT, env: childEnv, stdout: "pipe", stderr: "pipe" });
  try {
    const internal = run("internal:setup");
    const out = internal.stdout.toString();
    const line = out.split(/\r?\n/).find((l) => l.startsWith("WEBUI_LAUNCH_JSON="));
    let parsed: { version?: string; cmd?: string[] } | null = null;
    try {
      parsed = line ? (JSON.parse(line.slice("WEBUI_LAUNCH_JSON=".length)) as { version?: string; cmd?: string[] }) : null;
    } catch {
      /* leave null */
    }
    check("cli: internal:setup exits 0", internal.exitCode === 0, out.slice(0, 120));
    check("cli: internal:setup reports a version + argv", typeof parsed?.version === "string" && Array.isArray(parsed?.cmd) && (parsed?.cmd?.length ?? 0) > 0, line ?? "(no line)");
    check("cli: internal:setup wrote the wrapper + plugin", existsSync(join(bin, "opencode-webui")) && existsSync(join(config, "opencode", "plugins", "opencode-webui", "index.js")));

    const status = run("status");
    check("cli: status exits 0", status.exitCode === 0);
    check("cli: status names the command", status.stdout.toString().includes("command:"));

    const help = run("help");
    check("cli: help exits 0 and lists update", help.exitCode === 0 && help.stdout.toString().includes("update"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// update guardrails (no network): unknown action, dev checkout, help
// ---------------------------------------------------------------------------
{
  check("cli: unknown command exits 1", (await runSetupCli("definitely-not-a-command", "file:///opt/app/server/index.ts")) === 1);
  check("cli: update on a dev checkout exits 1 (no network)", (await runSetupCli("update", import.meta.url)) === 1);
  check("cli: compiled binary update refuses", (await runSetupCli("update", "file:///$bunfs/root/x")) === 1);
}

console.log(`\nRESULT: ${passed} pass · ${failed} fail → exit ${failed > 0 ? 1 : 0}`);
process.exit(failed > 0 ? 1 : 0);
