/**
 * First-run setup — a fast global command and an OpenCode lifecycle plugin.
 *
 * The webui is a foreground process; `bunx opencode-webui` re-resolves the
 * package each time (slow) and nothing restarts it after a reboot. This module
 * makes the webui self-install, once, into the user's environment:
 *
 *   1. a launcher shim on PATH (`~/.local/bin/opencode-webui`) that execs the
 *      installed entry with bun directly — no bunx resolution, no network;
 *      a bunx install lives in a temp dir the OS can wipe, so it is first
 *      mirrored to `<state>/entry/<version>/` (hardlinks — no disk, no
 *      network) and the shim + plugin launch from the mirror;
 *   2. the built-in OpenCode lifecycle plugin in
 *      `<config>/opencode/plugins/opencode-webui/`, which the engine
 *      auto-discovers globally and activates on use: it starts the webui
 *      detached, so the webui comes up whenever you use OpenCode;
 *   3. `launch.json` in the state dir — the stable handoff the plugin reads;
 *   4. a pidfile so `stop` / `restart` / `update` can find the running server.
 *
 * Gating, one state the user owns (same shape as before): a dev checkout and
 * `WEBUI_SANDBOX=1` never install; `WEBUI_NO_SETUP=1` (or `WEBUI_NO_PLUGIN=1`
 * for just the plugin) skips a run; `uninstall` removes everything and records
 * the decline so the next boot does not resurrect it. Files are only
 * overwritten when they carry our own marker — a foreign file of the same name
 * is left alone and reported.
 *
 * This is a deliberate, documented exception to the "webui never installs
 * engine plugins" rule in docs/engine-payload-convention.md: the webui installs
 * *its own* lifecycle plugin, opt-out, because the user asked for the webui to
 * follow OpenCode's lifecycle.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LIFECYCLE_PLUGIN_PACKAGE_JSON,
  LIFECYCLE_PLUGIN_SOURCE,
} from "./lifecyclePlugin";
import { runConfigCli } from "./config";

export const SERVICE_NAME = "opencode-webui";
const REPO_URL = "https://github.com/AbdelftahZowail/opencode-webui";
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const MANAGED_MARK = "managed by opencode-webui";
const PLUGIN_MARKER = ".opencode-webui.json";

export type SetupStatus =
  | "installed"
  | "updated"
  | "present"
  | "declined"
  | "disabled"
  | "dev"
  | "error";

export interface LaunchCommand {
  /** argv for the launcher + plugin (absolute paths — no inherited PATH). */
  cmd: string[];
  /** Human form for hints, e.g. `bunx opencode-webui`. */
  display: string;
}

export interface SetupOptions {
  /** `import.meta.url` of the server entry (index.ts). */
  entryUrl: string;
  port: number;
  version: string;
  /** Explicit `setup`: ignore dev-checkout and declined gates. */
  force?: boolean;
  quiet?: boolean;
  /** Config `autostart` — false skips first-run setup (unless forced). */
  autostart?: boolean;
}

export interface SetupResult {
  status: SetupStatus;
  message: string | null;
  wrapper: string | null;
  plugin: string | null;
}

export interface SetupStatusInfo {
  wrapper: string | null;
  wrapperPresent: boolean;
  wrapperOnPath: boolean;
  plugin: string | null;
  pluginPresent: boolean;
  launch: LaunchCommand | null;
  declined: boolean;
  pid: number | null;
  port: number | null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function stateDir(): string {
  const base =
    process.env.XDG_STATE_HOME ??
    (process.platform === "win32"
      ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
      : join(homedir(), ".local", "state"));
  return join(base, SERVICE_NAME);
}

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}

function launchFilePath(): string {
  return join(stateDir(), "launch.json");
}

function pidFilePath(): string {
  return join(stateDir(), "webui.pid");
}

function markerPath(): string {
  return join(stateDir(), "setup.json");
}

// ---------------------------------------------------------------------------
// Launch command + version
// ---------------------------------------------------------------------------

/** Compiled binaries get a virtual ($bunfs) entry URL but a real execPath. */
export function resolveLaunchCommand(entryUrl: string): LaunchCommand {
  const exec = process.execPath;
  if (entryUrl.includes("bunfs")) return { cmd: [exec], display: exec };
  const script = fileURLToPath(entryUrl);
  const isBun = /(^|[\\/])bun(\.exe)?$/i.test(exec);
  if (isBun) return { cmd: [exec, script], display: `bunx ${SERVICE_NAME}` };
  return { cmd: [exec, script], display: `${exec} ${script}` };
}

// ---------------------------------------------------------------------------
// Ephemeral bunx installs → stable entry
// ---------------------------------------------------------------------------

export interface StabilizedEntry {
  /** The entry to launch — the mirror URL when one was made, else the input. */
  url: string;
  /** Set only when the mirror was needed and could not be made. */
  detail?: string;
}

/** The install root a script belongs to: the directory before `node_modules`. */
function installRootOf(script: string): { root: string; rel: string } | null {
  const marker = `${sep}node_modules${sep}`;
  const at = script.lastIndexOf(marker);
  if (at <= 0) return null;
  return { root: script.slice(0, at), rel: script.slice(at + sep.length) };
}

/** True when `child` sits inside `parent` (the shell's ancestor test). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Mirror one install tree; hardlinks first (bun's own cache backend), copies as the fallback. */
function mirrorInstall(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    const stats = lstatSync(src);
    if (stats.isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(src), dest);
      } catch {
        // No symlink rights (Windows). Materialize the target instead.
        if (statSync(src).isDirectory()) mirrorInstall(src, dest);
        else {
          copyFileSync(src, dest);
          chmodSync(dest, statSync(src).mode & 0o777);
        }
      }
    } else if (stats.isDirectory()) {
      mirrorInstall(src, dest);
    } else if (stats.isFile()) {
      try {
        linkSync(src, dest);
      } catch {
        // Cross-device or a filesystem without hardlinks.
        copyFileSync(src, dest);
        chmodSync(dest, stats.mode & 0o777);
      }
    }
  }
}

/** Remove staging leftovers from a killed boot (a live mirror takes seconds). */
function sweepStaleStaging(entryDir: string): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    for (const name of readdirSync(entryDir)) {
      if (!name.startsWith(".staging-")) continue;
      try {
        const at = join(entryDir, name);
        if (lstatSync(at).mtimeMs < cutoff) rmSync(at, { recursive: true, force: true });
      } catch {
        /* raced with another boot */
      }
    }
  } catch {
    /* entry dir does not exist yet */
  }
}

/**
 * `bunx` runs the package from a temp dir (`<tmp>/bunx-<uid>-<name>@<ver>/`)
 * that the OS may wipe at any reboot. A wrapper or `launch.json` pointing
 * there then dies with "Module not found" — the command breaks and the webui
 * cannot autostart. Mirror the running install into a stable per-version
 * `<state>/entry/<version>/` and launch from there. Hardlinks keep the mirror
 * free and the whole step offline; stale versions stay behind inertly (they
 * cost only the files that changed between versions).
 */
export function stabilizeEntryUrl(
  entryUrl: string,
  version: string,
  tmpRoot: string = tmpdir(),
): StabilizedEntry {
  if (entryUrl.includes("bunfs")) return { url: entryUrl };
  let script: string;
  try {
    script = fileURLToPath(entryUrl);
  } catch {
    return { url: entryUrl };
  }
  if (!isInside(tmpRoot, script)) return { url: entryUrl };
  const tempName = relative(tmpRoot, script).split(sep)[0] ?? "";
  if (!tempName.startsWith("bunx-")) return { url: entryUrl };
  const layout = installRootOf(script);
  if (!layout) return { url: entryUrl };

  const entryDir = join(stateDir(), "entry");
  const destRoot = join(entryDir, version);
  const dest = join(destRoot, layout.rel);
  if (existsSync(dest)) return { url: pathToFileURL(dest).href };

  const staging = join(entryDir, `.staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(entryDir, { recursive: true, mode: 0o700 });
    sweepStaleStaging(entryDir);
    mirrorInstall(layout.root, staging);
    try {
      renameSync(staging, destRoot);
    } catch (renameErr) {
      // A concurrent boot may have mirrored this version first — use its copy.
      if (!existsSync(dest)) throw renameErr;
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    return { url: entryUrl, detail: `could not mirror the bunx install into ${destRoot}: ${errorText(err)}` };
  }
  if (!existsSync(dest)) return { url: entryUrl, detail: `mirrored entry is missing at ${dest}` };
  return { url: pathToFileURL(dest).href };
}

function readOwnVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isDevCheckout(): boolean {
  try {
    return existsSync(fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// launch.json — the webui -> plugin handoff
// ---------------------------------------------------------------------------

interface LaunchFile {
  cmd: string[];
  display: string;
  port: number;
  version: string;
  updatedAt: number;
}

/** Meaningful fields only — `updatedAt` must not make a steady state "change". */
function launchSignature(launch: { cmd: string[]; display: string; port: number; version: string }): string {
  return JSON.stringify([launch.cmd, launch.display, launch.port, launch.version]);
}

export function writeLaunchConfig(launch: LaunchCommand, port: number, version: string): boolean {
  try {
    const current = readLaunchConfig();
    if (current && launchSignature(current) === launchSignature({ ...launch, port, version })) return false;
  } catch {
    /* treat unreadable as changed */
  }
  const next: LaunchFile = {
    cmd: launch.cmd,
    display: launch.display,
    port,
    version,
    updatedAt: Date.now(),
  };
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(launchFilePath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    chmodSync(launchFilePath(), 0o600);
    return true;
  } catch {
    return false;
  }
}

export function readLaunchConfig(): LaunchFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(launchFilePath(), "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as LaunchFile).cmd)) {
      return parsed as LaunchFile;
    }
  } catch {
    /* absent/corrupt */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wrapper + plugin install
// ---------------------------------------------------------------------------

function pathHasDir(dir: string): boolean {
  const target = dir.replace(/[\\/]+$/, "");
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((p) => p.replace(/[\\/]+$/, ""))
    .some((p) => p === target);
}

/** First existing bin dir we can own: explicit env, then the usual user dirs. */
function wrapperDir(): string | null {
  const explicit = process.env.WEBUI_BIN_DIR;
  if (explicit && explicit.length > 0) return explicit;
  const candidates =
    process.platform === "win32"
      ? [join(homedir(), ".bun", "bin"), join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm")]
      : [join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not a directory (yet) */
    }
  }
  // Create the conventional user bin dir rather than skipping setup.
  const fallback = candidates[0] ?? null;
  if (!fallback) return null;
  try {
    mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return null;
  }
}

function wrapperPath(): string | null {
  const dir = wrapperDir();
  if (!dir) return null;
  return join(dir, process.platform === "win32" ? `${SERVICE_NAME}.cmd` : SERVICE_NAME);
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderWrapper(cmd: string[], windows = process.platform === "win32"): string {
  if (windows) {
    const quoted = cmd.map((arg) => `"${arg.replace(/"/g, '""')}"`).join(" ");
    return [
      "@echo off",
      `rem ${MANAGED_MARK} — do not edit. Remove: ${SERVICE_NAME} uninstall`,
      `${quoted} %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `# ${MANAGED_MARK} — regenerated on each boot. Remove: ${SERVICE_NAME} uninstall`,
    `exec ${cmd.map(posixShellQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
}

interface InstallResult {
  path: string | null;
  changed: boolean;
  detail?: string;
}

function installWrapper(launch: LaunchCommand): InstallResult {
  const path = wrapperPath();
  if (!path) return { path: null, changed: false, detail: "no writable bin directory on PATH" };
  const content = renderWrapper(launch.cmd);
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8");
      if (!existing.includes(MANAGED_MARK)) {
        return { path, changed: false, detail: `left ${path} untouched (not managed by us)` };
      }
      if (existing === content) return { path, changed: false };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o755 });
    chmodSync(path, 0o755);
    return { path, changed: true };
  } catch (err) {
    return { path, changed: false, detail: `could not write ${path}: ${errorText(err)}` };
  }
}

function pluginDir(): string {
  return join(configDir(), "plugins", SERVICE_NAME);
}

function installPlugin(version: string): InstallResult {
  const dir = pluginDir();
  const marker = join(dir, PLUGIN_MARKER);
  try {
    if (existsSync(dir) && !existsSync(marker)) {
      return { path: dir, changed: false, detail: `left ${dir} untouched (not managed by us)` };
    }
    const index = join(dir, "index.js");
    const pkg = join(dir, "package.json");
    const markerContent = JSON.stringify({ managed: true, version }, null, 2) + "\n";
    const unchanged =
      existsSync(index) &&
      readFileSync(index, "utf8") === LIFECYCLE_PLUGIN_SOURCE &&
      existsSync(pkg) &&
      readFileSync(pkg, "utf8") === LIFECYCLE_PLUGIN_PACKAGE_JSON &&
      existsSync(marker) &&
      readFileSync(marker, "utf8") === markerContent;
    if (unchanged) return { path: dir, changed: false };
    mkdirSync(dir, { recursive: true });
    writeFileSync(index, LIFECYCLE_PLUGIN_SOURCE);
    writeFileSync(pkg, LIFECYCLE_PLUGIN_PACKAGE_JSON);
    writeFileSync(marker, markerContent);
    return { path: dir, changed: true };
  } catch (err) {
    return { path: dir, changed: false, detail: `could not write ${dir}: ${errorText(err)}` };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Marker (declined state)
// ---------------------------------------------------------------------------

interface Marker {
  declined?: boolean;
  installedAt?: number;
  version?: string;
}

function readMarker(): Marker {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed as Marker;
  } catch {
    /* absent/corrupt */
  }
  return {};
}

function writeMarker(marker: Marker): void {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(), JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* read-only state dir must not break boot */
  }
}

// ---------------------------------------------------------------------------
// pidfile
// ---------------------------------------------------------------------------

export function writePidFile(port: number): void {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const content = JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }, null, 2) + "\n";
    writeFileSync(pidFilePath(), content, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function clearPidFile(): void {
  try {
    const raw = readFileSync(pidFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (parsed.pid !== process.pid) return; // a newer instance owns it
    rmSync(pidFilePath(), { force: true });
  } catch {
    /* absent */
  }
}

export function readPidFile(): { pid: number; port: number | null } | null {
  try {
    const parsed = JSON.parse(readFileSync(pidFilePath(), "utf8")) as { pid?: number; port?: number };
    if (typeof parsed.pid === "number") {
      return { pid: parsed.pid, port: typeof parsed.port === "number" ? parsed.port : null };
    }
  } catch {
    /* absent/corrupt */
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Linux: confirm the pid is actually a webui before signaling it. */
function pidLooksLikeOurs(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return cmdline.includes(SERVICE_NAME) || cmdline.includes("server/index");
    }
  } catch {
    return false;
  }
  return true;
}

/** Stop the running server (verified pidfile), if any. */
export function stopRunning(): boolean {
  const info = readPidFile();
  if (!info || !isAlive(info.pid) || !pidLooksLikeOurs(info.pid)) return false;
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isAlive(info.pid)) Bun.sleepSync(50);
  return true;
}

/** Spawn the given launch command detached so it outlives this process. */
export function spawnDetached(launch: LaunchCommand): boolean {
  try {
    const child = Bun.spawn(launch.cmd, {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, WEBUI_SPAWNED_BY: "cli" },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

function installArtifacts(launch: LaunchCommand, port: number, version: string): {
  changed: boolean;
  wrapper: InstallResult;
  plugin: InstallResult | null;
  problems: string[];
} {
  const launchChanged = writeLaunchConfig(launch, port, version);
  const wrapper = installWrapper(launch);
  const plugin = process.env.WEBUI_NO_PLUGIN === "1" ? null : installPlugin(version);
  const problems: string[] = [];
  if (wrapper.detail) problems.push(wrapper.detail);
  if (plugin?.detail) problems.push(plugin.detail);
  return {
    changed: launchChanged || wrapper.changed || (plugin?.changed ?? false),
    wrapper,
    plugin,
    problems,
  };
}

function setupMessage(result: {
  wrapper: InstallResult;
  plugin: InstallResult | null;
  first: boolean;
  problems: string[];
}): string {
  const lines: string[] = [];
  const at = result.wrapper.path ? ` at ${result.wrapper.path}` : "";
  lines.push(
    result.first
      ? `[webui] setup: installed the \`${SERVICE_NAME}\` command${at} and the OpenCode lifecycle plugin.`
      : `[webui] setup: refreshed the \`${SERVICE_NAME}\` command and lifecycle plugin.`,
  );
  lines.push(`[webui]   the webui now starts with OpenCode · undo: ${SERVICE_NAME} uninstall`);
  const dir = result.wrapper.path ? dirname(result.wrapper.path) : null;
  if (dir && !pathHasDir(dir)) {
    lines.push(`[webui]   note: ${dir} is not on PATH — add it: export PATH="${dir}:$PATH"`);
  }
  for (const problem of result.problems) lines.push(`[webui]   ${problem}`);
  return lines.join("\n");
}

/**
 * Ensure the global command + lifecycle plugin exist and match this build.
 * Called after the server binds; a matching install is a no-op. Never throws.
 */
export function ensureSetup(opts: SetupOptions): SetupResult {
  const marker = readMarker();
  const forced = opts.force === true;
  // WEBUI_SETUP=1 forces setup from a dev checkout (testing / power users);
  // it does NOT override an explicit uninstall — only `opencode-webui setup` does.
  const forceEnv = process.env.WEBUI_SETUP === "1";

  if (!forced) {
    if (opts.autostart === false || process.env.WEBUI_NO_SETUP === "1" || process.env.WEBUI_SANDBOX === "1") {
      return { status: "disabled", message: null, wrapper: null, plugin: null };
    }
    if (!forceEnv && isDevCheckout()) {
      return { status: "dev", message: null, wrapper: null, plugin: null };
    }
    if (marker.declined) {
      return { status: "declined", message: null, wrapper: null, plugin: null };
    }
  }

  const entry = stabilizeEntryUrl(opts.entryUrl, opts.version);
  const launch = resolveLaunchCommand(entry.url);
  const first = marker.installedAt === undefined;
  const result = installArtifacts(launch, opts.port, opts.version);
  if (entry.detail) result.problems.push(entry.detail);
  writeMarker({ declined: false, installedAt: marker.installedAt ?? Date.now(), version: opts.version });

  const status: SetupStatus = result.changed ? (first ? "installed" : "updated") : "present";
  const message =
    opts.quiet || status === "present"
      ? status === "present" && result.problems.length > 0
        ? result.problems.map((p) => `[webui] setup: ${p}`).join("\n")
        : null
      : setupMessage({ wrapper: result.wrapper, plugin: result.plugin, first, problems: result.problems });

  return {
    status,
    message,
    wrapper: result.wrapper.path,
    plugin: result.plugin?.path ?? null,
  };
}

export interface UninstallResult {
  removed: string[];
  problems: string[];
}

/** Remove the wrapper, plugin, and launch handoff; remember the choice. */
export function uninstallSetup(): UninstallResult {
  const removed: string[] = [];
  const problems: string[] = [];
  stopRunning();
  const path = wrapperPath();
  if (path && existsSync(path)) {
    try {
      if (readFileSync(path, "utf8").includes(MANAGED_MARK)) {
        rmSync(path, { force: true });
        removed.push(path);
      } else {
        problems.push(`left ${path} untouched (not managed by us)`);
      }
    } catch (err) {
      problems.push(errorText(err));
    }
  }
  const dir = pluginDir();
  if (existsSync(join(dir, PLUGIN_MARKER))) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      problems.push(errorText(err));
    }
  }
  try {
    rmSync(launchFilePath(), { force: true });
  } catch {
    /* absent */
  }
  const entry = join(stateDir(), "entry");
  if (existsSync(entry)) {
    try {
      rmSync(entry, { recursive: true, force: true });
      removed.push(entry);
    } catch (err) {
      problems.push(errorText(err));
    }
  }
  writeMarker({ declined: true, installedAt: Date.now(), version: readOwnVersion() });
  return { removed, problems };
}

export function setupStatus(): SetupStatusInfo {
  const wrapper = wrapperPath();
  const plugin = pluginDir();
  const launchFile = readLaunchConfig();
  const marker = readMarker();
  const info = readPidFile();
  return {
    wrapper,
    wrapperPresent: wrapper !== null && existsSync(wrapper),
    wrapperOnPath: wrapper !== null ? pathHasDir(dirname(wrapper)) : false,
    plugin,
    pluginPresent: existsSync(join(plugin, PLUGIN_MARKER)),
    launch: launchFile ? { cmd: launchFile.cmd, display: launchFile.display } : null,
    declined: marker.declined === true,
    pid: info && isAlive(info.pid) ? info.pid : null,
    port: info?.port ?? null,
  };
}

// ---------------------------------------------------------------------------
// CLI — `opencode-webui <setup|update|uninstall|status|stop|restart>`
// ---------------------------------------------------------------------------

const USAGE = `${SERVICE_NAME} [command]

  (none)      start the webui (starting the OpenCode service first if needed)
  update      update to the latest published version and restart
  status      show the command, lifecycle plugin, launch command, and pid
  config      show/edit serve + security settings (host, port, auth, hosts, …)
  stop        stop the running webui
  restart     restart the running webui
  uninstall   remove the global command + lifecycle plugin (remembered; no auto-reinstall)
  sandbox     start an isolated second instance (loopback, no password, port 4099)
  --install-skill   copy the agent skill and exit

Environment:
  WEBUI_NO_SETUP=1    skip first-run setup for one run (CI, one-offs)
  WEBUI_NO_PLUGIN=1   install the command but not the OpenCode lifecycle plugin
  WEBUI_SETUP=1       force setup even in a dev checkout (testing)`;

function printStatus(): number {
  const info = setupStatus();
  console.log(`${SERVICE_NAME} setup`);
  console.log(`  command:  ${info.wrapper ?? "(none)"} ${info.wrapperPresent ? "(present)" : "(missing)"}${info.wrapperOnPath ? "" : " — not on PATH"}`);
  console.log(`  plugin:   ${info.plugin} ${info.pluginPresent ? "(present)" : "(missing)"}`);
  console.log(`  launch:   ${info.launch ? info.launch.cmd.join(" ") : "(none)"}`);
  console.log(`  running:  ${info.pid ? `pid ${info.pid} :${info.port ?? "?"}` : "no"}`);
  if (info.declined) console.log("  declined: yes — `opencode-webui setup` re-enables auto-install");
  return 0;
}

/** Parse the `WEBUI_LAUNCH_JSON=` line a spawned `internal:setup` prints. */
function parseLaunchJson(stdout: string): { version: string; cmd: string[]; display: string; port: number } | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("WEBUI_LAUNCH_JSON=")) continue;
    try {
      const parsed = JSON.parse(line.slice("WEBUI_LAUNCH_JSON=".length)) as {
        version?: string;
        cmd?: string[];
        display?: string;
        port?: number;
      };
      if (typeof parsed.version === "string" && Array.isArray(parsed.cmd) && parsed.cmd.length > 0) {
        return {
          version: parsed.version,
          cmd: parsed.cmd,
          display: parsed.display ?? parsed.cmd.join(" "),
          port: typeof parsed.port === "number" ? parsed.port : 0,
        };
      }
    } catch {
      /* not the line */
    }
  }
  return null;
}

function runUpdate(entryUrl: string): number {
  if (entryUrl.includes("bunfs")) {
    console.log(`${SERVICE_NAME}: this is a compiled binary — download the latest from ${RELEASES_URL}`);
    return 1;
  }
  if (isDevCheckout()) {
    console.log(`${SERVICE_NAME}: dev checkout — update with \`git pull\` (nothing to fetch)`);
    return 1;
  }
  const bun = process.execPath;
  // `@latest` forces a fresh resolve + cache install. The timeout guards the
  // transition case: a published version without `internal:setup` would
  // otherwise start a server and block the probe.
  const probe = Bun.spawnSync([bun, "x", `${SERVICE_NAME}@latest`, "internal:setup"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const parsed = parseLaunchJson(probe.stdout.toString());
  if (!parsed) {
    console.error(`${SERVICE_NAME}: update failed — could not resolve the latest version`);
    const err = probe.stderr.toString().trim();
    if (err) console.error(err.split("\n").slice(0, 5).join("\n"));
    return 1;
  }
  const current = readOwnVersion();
  const launch: LaunchCommand = { cmd: parsed.cmd, display: parsed.display };
  stopRunning();
  spawnDetached(launch);
  if (parsed.version === current) {
    console.log(`${SERVICE_NAME}: already on the latest version (v${current}) — restarted`);
    return 0;
  }
  console.log(`${SERVICE_NAME}: updated v${current} → v${parsed.version} — restarted`);
  return 0;
}

/** The hidden `internal:setup`: install from the *new* version and report it. */
function runInternalSetup(entryUrl: string): number {
  const version = readOwnVersion();
  const port = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
  const launch = resolveLaunchCommand(entryUrl);
  installArtifacts(launch, port, version);
  writeMarker({ declined: false, installedAt: readMarker().installedAt ?? Date.now(), version });
  console.log(
    `WEBUI_LAUNCH_JSON=${JSON.stringify({ version, cmd: launch.cmd, display: launch.display, port })}`,
  );
  return 0;
}

export async function runSetupCli(action: string | undefined, entryUrl: string, rest: string[] = []): Promise<number> {
  switch (action) {
    case "config":
      return runConfigCli(rest);
    case "internal:setup":
      return runInternalSetup(entryUrl);
    case "update":
      return runUpdate(entryUrl);
    case "status":
      return printStatus();
    case "stop":
      console.log(stopRunning() ? `${SERVICE_NAME}: stopped` : `${SERVICE_NAME}: not running`);
      return 0;
    case "restart": {
      const launch = readLaunchConfig();
      stopRunning();
      const command: LaunchCommand = launch
        ? { cmd: launch.cmd, display: launch.display }
        : resolveLaunchCommand(entryUrl);
      const ok = spawnDetached(command);
      console.log(ok ? `${SERVICE_NAME}: restarted` : `${SERVICE_NAME}: could not restart`);
      return ok ? 0 : 1;
    }
    case "uninstall": {
      const result = uninstallSetup();
      console.log(
        result.removed.length > 0
          ? `${SERVICE_NAME}: removed ${result.removed.join(", ")}`
          : `${SERVICE_NAME}: nothing to remove`,
      );
      for (const problem of result.problems) console.error(`  ${problem}`);
      console.log("  the next boot will NOT reinstall (declined); `opencode-webui setup` re-enables");
      return 0;
    }
    case "setup": {
      const version = readOwnVersion();
      const port = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
      const result = ensureSetup({ entryUrl, port, version, force: true, quiet: true });
      if (result.status === "disabled") {
        console.log(`${SERVICE_NAME}: skipped (sandbox mode)`);
        return 0;
      }
      if (result.status === "error") {
        console.error(`${SERVICE_NAME}: setup failed — ${result.message ?? ""}`);
        return 1;
      }
      console.log(`${SERVICE_NAME}: setup ${result.status}${result.wrapper ? ` → ${result.wrapper}` : ""}`);
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      if (!action) {
        console.log(USAGE);
        return 1;
      }
      console.error(`unknown command: ${action}\n`);
      console.error(USAGE);
      return 1;
  }
}
