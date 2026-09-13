/**
 * Webui configuration — ONE persisted file, env overrides, one apply path.
 *
 * Serve/security knobs used to be env-only and were read once at boot, which
 * meant the plugin-spawned background instance (whose env comes from the
 * engine, not your shell) could silently fall back to different host/password
 * values. This module makes them durable:
 *
 *   ~/.config/opencode/webui/config.json   (chmod 600)
 *
 * Precedence per key: explicit env var > config file > built-in default. The
 * env escape hatch stays, so container/CI setups are unaffected. The CLI
 * (`opencode-webui config …`) and the Settings › Access tab both edit this one
 * file; nothing else persists serve settings.
 *
 * Passwords: `WEBUI_PASSWORD` is plaintext and never written. A password set
 * through the CLI/UI is stored as a SHA-256 `passwordHash`, mirroring the
 * in-memory digest the server already compares. `auth: "none"` disables the
 * login entirely — allowed, but always warned about when the bind is reachable.
 *
 * Applying changes requires a restart (Bun binds the socket once and the auth
 * digest is in memory); the API reports `restartRequired` and the CLI/UI reuse
 * the existing restart machinery. No hot-reload of network settings, by design.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoopbackHostname, isWildcardHostname, hostnameOf } from "./auth";

export type AuthMode = "password" | "none";

export interface WebuiConfig {
  /** Bind address. Loopback by default; `0.0.0.0`/`::` expose to the network. */
  host: string;
  port: number;
  /** `"password"` (default) or `"none"` — no login at all. */
  auth: AuthMode;
  /** SHA-256 hex of a password set via config; never plaintext. */
  passwordHash: string | null;
  /** Extra accepted Host headers (comma-separated in `WEBUI_ALLOWED_HOSTS`). */
  allowedHosts: string[];
  /** Honor X-Forwarded-Host/Proto (trusted reverse proxy in front). */
  trustProxy: boolean;
  /** Install the global command + lifecycle plugin on boot. */
  autostart: boolean;
  /** Canonical public URL, for display (e.g. behind Tailscale serve). */
  publicUrl: string | null;
}

export type SourceKind = "env" | "file" | "default";

export interface EffectiveConfig extends WebuiConfig {
  /** Per-key provenance, so the UI can show why a field is locked. */
  sources: Record<keyof WebuiConfig, SourceKind>;
  /** Plaintext `WEBUI_PASSWORD` from the env (never persisted). */
  envPassword: string | null;
}

export const DEFAULTS: WebuiConfig = {
  host: "127.0.0.1",
  port: 4097,
  auth: "password",
  passwordHash: null,
  allowedHosts: [],
  trustProxy: false,
  autostart: true,
  publicUrl: null,
};

const KEYS: Array<keyof WebuiConfig> = [
  "host",
  "port",
  "auth",
  "passwordHash",
  "allowedHosts",
  "trustProxy",
  "autostart",
  "publicUrl",
];

/**
 * The environment variable that pins each key (null = env cannot set it).
 * Exported so the settings API can tell the UI WHICH variable is overriding a
 * field — "env" alone leaves the user hunting for a file that does not exist.
 */
export const ENV_KEYS: Record<keyof WebuiConfig, string | null> = {
  host: "WEBUI_HOST",
  port: "WEBUI_PROXY_PORT",
  auth: "WEBUI_PASSWORD",
  passwordHash: "WEBUI_PASSWORD",
  allowedHosts: "WEBUI_ALLOWED_HOSTS",
  trustProxy: "WEBUI_TRUST_PROXY",
  autostart: "WEBUI_NO_SETUP",
  publicUrl: null,
};

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function configBaseDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "webui");
}

export function configPath(): string {
  return join(configBaseDir(), "config.json");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Parse + validate on read; unknown/invalid fields fall back to defaults. */
export function readFileConfig(): WebuiConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const input = raw as Record<string, unknown>;
  const out: WebuiConfig = { ...DEFAULTS };
  if (typeof input.host === "string" && input.host.length > 0) out.host = input.host;
  if (typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 && input.port < 65536) out.port = input.port;
  if (input.auth === "password" || input.auth === "none") out.auth = input.auth;
  if (typeof input.passwordHash === "string" && /^[0-9a-f]{64}$/i.test(input.passwordHash)) out.passwordHash = input.passwordHash.toLowerCase();
  if (Array.isArray(input.allowedHosts)) out.allowedHosts = input.allowedHosts.filter((v): v is string => typeof v === "string");
  if (typeof input.trustProxy === "boolean") out.trustProxy = input.trustProxy;
  if (typeof input.autostart === "boolean") out.autostart = input.autostart;
  if (typeof input.publicUrl === "string" && input.publicUrl.length > 0) out.publicUrl = input.publicUrl;
  return out;
}

function writeFileConfig(config: WebuiConfig): void {
  mkdirSync(configBaseDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

// ---------------------------------------------------------------------------
// Resolution (env > file > default)
// ---------------------------------------------------------------------------

function envPort(): number | undefined {
  const raw = nonEmpty(process.env.WEBUI_PROXY_PORT);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

function envAllowedHosts(): string[] | undefined {
  const raw = process.env.WEBUI_ALLOWED_HOSTS;
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => hostnameOf(s.trim()))
    .filter((s) => s.length > 0);
}

/** Effective config with per-key provenance. Never throws. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): EffectiveConfig {
  const file = readFileConfig();
  const sources = {} as Record<keyof WebuiConfig, SourceKind>;
  for (const key of KEYS) sources[key] = "file";

  const envHost = nonEmpty(env.WEBUI_HOST);
  const host = envHost ?? file.host;
  sources.host = envHost !== undefined ? "env" : existsSync(configPath()) ? "file" : "default";

  const ePort = envPort();
  const port = ePort ?? file.port;
  sources.port = ePort !== undefined ? "env" : existsSync(configPath()) ? "file" : "default";

  const envPassword = nonEmpty(env.WEBUI_PASSWORD) ?? null;
  // Env password forces password auth; otherwise the file decides.
  const auth: AuthMode = envPassword ? "password" : file.auth;
  sources.auth = envPassword ? "env" : existsSync(configPath()) ? "file" : "default";
  sources.passwordHash = existsSync(configPath()) ? "file" : "default";

  const eHosts = envAllowedHosts();
  const allowedHosts = eHosts ?? file.allowedHosts;
  sources.allowedHosts = eHosts !== undefined ? "env" : existsSync(configPath()) ? "file" : "default";

  const envTrust = env.WEBUI_TRUST_PROXY;
  const trustProxy = envTrust !== undefined ? envTrust === "1" : file.trustProxy;
  sources.trustProxy = envTrust !== undefined ? "env" : existsSync(configPath()) ? "file" : "default";

  const envNoSetup = env.WEBUI_NO_SETUP;
  const autostart = envNoSetup !== undefined ? envNoSetup !== "1" : file.autostart;
  sources.autostart = envNoSetup !== undefined ? "env" : existsSync(configPath()) ? "file" : "default";

  sources.publicUrl = existsSync(configPath()) ? "file" : "default";

  return { host, port, auth, passwordHash: file.passwordHash, allowedHosts, trustProxy, autostart, publicUrl: file.publicUrl, sources, envPassword };
}

// ---------------------------------------------------------------------------
// Validation + mutation
// ---------------------------------------------------------------------------

export interface ConfigPatch {
  host?: string;
  port?: number;
  auth?: AuthMode;
  /** Plaintext; hashed before storage. Omitted = unchanged. */
  password?: string;
  /** Explicitly remove the stored password hash. */
  clearPassword?: boolean;
  allowedHosts?: string[];
  trustProxy?: boolean;
  autostart?: boolean;
  publicUrl?: string | null;
}

/** Field-level errors, empty = valid. */
export function validatePatch(patch: ConfigPatch): string[] {
  const errors: string[] = [];
  if (patch.host !== undefined && (typeof patch.host !== "string" || patch.host.trim().length === 0)) {
    errors.push("host must be a non-empty address");
  }
  if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
    errors.push("port must be an integer between 1 and 65535");
  }
  if (patch.auth !== undefined && patch.auth !== "password" && patch.auth !== "none") {
    errors.push('auth must be "password" or "none"');
  }
  if (patch.password !== undefined && typeof patch.password === "string" && patch.password.length > 0 && patch.password.length < 8) {
    errors.push("password must be at least 8 characters");
  }
  if (patch.allowedHosts !== undefined && (!Array.isArray(patch.allowedHosts) || patch.allowedHosts.some((v) => typeof v !== "string"))) {
    errors.push("allowedHosts must be an array of strings");
  }
  if (patch.publicUrl !== undefined && patch.publicUrl !== null) {
    try {
      new URL(patch.publicUrl);
    } catch {
      errors.push("publicUrl must be a valid URL");
    }
  }
  return errors;
}

function normalizeHostEntry(entry: string): string {
  return hostnameOf(entry.trim());
}

/**
 * Pure merge (no I/O) — lets callers preview the exposure of a pending change
 * before committing it. Unknown fields are ignored.
 */
export function mergePatch(current: WebuiConfig, patch: ConfigPatch): WebuiConfig {
  const next: WebuiConfig = { ...current };
  if (patch.host !== undefined) next.host = patch.host.trim();
  if (patch.port !== undefined) next.port = patch.port;
  if (patch.auth !== undefined) next.auth = patch.auth;
  if (patch.clearPassword === true) next.passwordHash = null;
  if (typeof patch.password === "string" && patch.password.length > 0) next.passwordHash = hashPassword(patch.password);
  if (patch.allowedHosts !== undefined) next.allowedHosts = patch.allowedHosts.map(normalizeHostEntry).filter((s) => s.length > 0);
  if (patch.trustProxy !== undefined) next.trustProxy = patch.trustProxy;
  if (patch.autostart !== undefined) next.autostart = patch.autostart;
  if (patch.publicUrl !== undefined) next.publicUrl = patch.publicUrl === null ? null : patch.publicUrl.trim();
  return next;
}

/** Merge a validated patch into the file and persist. */
export function applyConfigPatch(patch: ConfigPatch): WebuiConfig {
  const next = mergePatch(readFileConfig(), patch);
  writeFileConfig(next);
  return next;
}

/** Reset one key to its default (remove from the file). */
export function resetConfigKey(key: keyof WebuiConfig): WebuiConfig {
  const next = readFileConfig();
  next[key] = DEFAULTS[key] as never;
  writeFileConfig(next);
  return next;
}

export function hashPassword(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Exposure analysis (the warnings the UI shows)
// ---------------------------------------------------------------------------

export type ExposureLevel = "ok" | "warn" | "danger";

export interface Exposure {
  level: ExposureLevel;
  /** True when the bind/hosts are reachable beyond this machine. */
  exposed: boolean;
  /** True when there is no login in front of an exposed instance. */
  unauthenticated: boolean;
  message: string | null;
}

export function analyzeExposure(config: Pick<WebuiConfig, "host" | "auth" | "allowedHosts">): Exposure {
  const bind = hostnameOf(config.host);
  const wildcard = isWildcardHostname(bind);
  const loopback = isLoopbackHostname(bind);
  const anyHost = config.allowedHosts.includes("*");
  const exposed = wildcard || !loopback || anyHost || config.allowedHosts.length > 0;
  const unauthenticated = config.auth === "none";
  if (unauthenticated && exposed) {
    return {
      level: "danger",
      exposed,
      unauthenticated,
      message:
        "No password and not loopback-only — anyone who can reach this port gets full access to your sessions and files.",
    };
  }
  if (exposed) {
    return {
      level: "warn",
      exposed,
      unauthenticated,
      message: anyHost
        ? "The allowed-hosts list contains * — the Host check accepts anything. Fine behind a trusted proxy, risky otherwise."
        : "Reachable beyond this machine. Make sure the network (and your password) is trusted.",
    };
  }
  return { level: "ok", exposed, unauthenticated, message: null };
}

// ---------------------------------------------------------------------------
// API shape (never leaks a password or hash)
// ---------------------------------------------------------------------------

export interface RedactedConfig {
  host: string;
  port: number;
  auth: AuthMode;
  passwordSet: boolean;
  allowedHosts: string[];
  trustProxy: boolean;
  autostart: boolean;
  publicUrl: string | null;
}

export function redact(config: WebuiConfig, passwordSet = config.passwordHash !== null): RedactedConfig {
  return {
    host: config.host,
    port: config.port,
    auth: config.auth,
    passwordSet,
    allowedHosts: [...config.allowedHosts],
    trustProxy: config.trustProxy,
    autostart: config.autostart,
    publicUrl: config.publicUrl,
  };
}

// ---------------------------------------------------------------------------
// CLI — `opencode-webui config <get|set|unset|path>`
// ---------------------------------------------------------------------------

const CLI_FIELDS: Record<string, keyof WebuiConfig> = {
  host: "host",
  port: "port",
  auth: "auth",
  password: "passwordHash",
  "allowed-hosts": "allowedHosts",
  "trust-proxy": "trustProxy",
  autostart: "autostart",
  "public-url": "publicUrl",
};

const CONFIG_USAGE = `opencode-webui config <command>

  get                     show effective values and where each came from
  set <key> <value...>    set a value (add --confirm to allow a risky one)
  unset <key>             reset a key to its default
  path                    print the config file path

  keys: host · port · auth (password|none) · password · allowed-hosts ·
        trust-proxy · autostart · public-url

Restart to apply: opencode-webui restart`;

function truthy(value: string): boolean {
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function cliPatch(key: string, value: string): ConfigPatch {
  switch (key) {
    case "host":
      return { host: value };
    case "port":
      return { port: Number(value) };
    case "auth":
      return { auth: value as AuthMode };
    case "password":
      return { password: value, auth: "password" };
    case "allowed-hosts":
      return { allowedHosts: value.split(",").map((s) => s.trim()).filter((s) => s.length > 0) };
    case "trust-proxy":
      return { trustProxy: truthy(value) };
    case "autostart":
      return { autostart: truthy(value) };
    case "public-url":
      return { publicUrl: value === "" || value === "none" ? null : value };
    default:
      return {};
  }
}

async function readStdinLine(): Promise<string> {
  try {
    const text = await Bun.stdin.text();
    return text.split(/\r?\n/)[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

export async function runConfigCli(args: string[]): Promise<number> {
  const confirm = args.includes("--confirm");
  const rest = args.filter((a) => a !== "--confirm");
  const action = rest[0];

  if (!action || action === "help" || action === "-h" || action === "--help") {
    console.log(CONFIG_USAGE);
    return action ? 0 : 1;
  }
  if (action === "path") {
    console.log(configPath());
    return 0;
  }
  if (action === "get") {
    const now = resolveConfig();
    const rows: Array<[string, string, SourceKind]> = [
      ["host", now.host, now.sources.host],
      ["port", String(now.port), now.sources.port],
      ["auth", now.auth, now.sources.auth],
      [
        "password",
        now.envPassword ? "set (WEBUI_PASSWORD)" : now.passwordHash ? "set (config)" : "(none)",
        now.envPassword ? "env" : now.sources.passwordHash,
      ],
      ["allowed-hosts", now.allowedHosts.join(",") || "(none)", now.sources.allowedHosts],
      ["trust-proxy", String(now.trustProxy), now.sources.trustProxy],
      ["autostart", String(now.autostart), now.sources.autostart],
      ["public-url", now.publicUrl ?? "(none)", now.sources.publicUrl],
    ];
    console.log(`config: ${configPath()}`);
    for (const [key, value, source] of rows) console.log(`  ${key.padEnd(14)} ${value.padEnd(26)} [${source}]`);
    const exposure = analyzeExposure(now);
    if (exposure.level !== "ok") console.log(`  warning        ${exposure.message}`);
    return 0;
  }
  if (action === "set") {
    const key = rest[1];
    if (!key || !(key in CLI_FIELDS)) {
      console.error(`unknown key: ${key ?? "(none)"}\n`);
      console.error(CONFIG_USAGE);
      return 1;
    }
    let value = rest.slice(2).join(" ").trim();
    if (key === "password" && value.length === 0) value = await readStdinLine();
    const patch = cliPatch(key, value);
    const errors = validatePatch(patch);
    if (errors.length > 0) {
      console.error(`config: ${errors.join("; ")}`);
      return 1;
    }
    const pending = analyzeExposure(mergePatch(readFileConfig(), patch));
    if (pending.level === "danger" && !confirm) {
      console.error(`config: refused — ${pending.message}`);
      console.error("  re-run with --confirm if that is what you want.");
      return 1;
    }
    applyConfigPatch(patch);
    console.log(`config: ${key} set`);
    console.log("  restart to apply: opencode-webui restart");
    return 0;
  }
  if (action === "unset") {
    const key = rest[1];
    if (!key || !(key in CLI_FIELDS)) {
      console.error(`unknown key: ${key ?? "(none)"}\n`);
      console.error(CONFIG_USAGE);
      return 1;
    }
    resetConfigKey(CLI_FIELDS[key]!);
    console.log(`config: ${key} reset to default`);
    console.log("  restart to apply: opencode-webui restart");
    return 0;
  }
  console.error(`unknown config command: ${action}\n`);
  console.error(CONFIG_USAGE);
  return 1;
}
