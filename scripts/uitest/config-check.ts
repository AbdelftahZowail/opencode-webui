#!/usr/bin/env bun
/**
 * Serve/security config contract check — pure resolution, validation, exposure,
 * and the `opencode-webui config` CLI. Everything is routed to a throwaway
 * XDG_CONFIG_HOME, so the real config file is never touched.
 *
 *   bun run check:config
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_KEYS,
  analyzeExposure,
  applyConfigPatch,
  configPath,
  mergePatch,
  readFileConfig,
  redact,
  resolveConfig,
  runConfigCli,
  validatePatch,
} from "../../server/config";

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

const tmp = mkdtempSync(join(tmpdir(), "webui-config-check-"));
const saved = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  WEBUI_HOST: process.env.WEBUI_HOST,
  WEBUI_PROXY_PORT: process.env.WEBUI_PROXY_PORT,
  WEBUI_ALLOWED_HOSTS: process.env.WEBUI_ALLOWED_HOSTS,
  WEBUI_TRUST_PROXY: process.env.WEBUI_TRUST_PROXY,
  WEBUI_NO_SETUP: process.env.WEBUI_NO_SETUP,
  WEBUI_PASSWORD: process.env.WEBUI_PASSWORD,
};
function clearEnv(): void {
  for (const key of ["WEBUI_HOST", "WEBUI_PROXY_PORT", "WEBUI_ALLOWED_HOSTS", "WEBUI_TRUST_PROXY", "WEBUI_NO_SETUP", "WEBUI_PASSWORD"]) {
    delete process.env[key];
  }
}
process.env.XDG_CONFIG_HOME = tmp;

try {
  // --- defaults, no file ---------------------------------------------------
  clearEnv();
  {
    const cfg = resolveConfig();
    check("default: loopback host", cfg.host === "127.0.0.1");
    check("default: port 4097", cfg.port === 4097);
    check("default: password auth", cfg.auth === "password");
    check("default: no file yet", !existsSync(configPath()));
    check("default: sources marked default", cfg.sources.host === "default" && cfg.sources.port === "default");
  }

  // --- env overrides win over file -----------------------------------------
  {
    applyConfigPatch({ host: "10.0.0.1", port: 5000, allowedHosts: ["a.lan"] });
    process.env.WEBUI_HOST = "127.0.0.1";
    process.env.WEBUI_PROXY_PORT = "6000";
    process.env.WEBUI_ALLOWED_HOSTS = "b.lan, c.lan:1234";
    process.env.WEBUI_TRUST_PROXY = "1";
    process.env.WEBUI_NO_SETUP = "1";
    const cfg = resolveConfig();
    check("env: host overrides file", cfg.host === "127.0.0.1" && cfg.sources.host === "env");
    check("env: port overrides file", cfg.port === 6000 && cfg.sources.port === "env");
    check("env: allowed hosts override file", cfg.allowedHosts.join(",") === "b.lan,c.lan" && cfg.sources.allowedHosts === "env");
    check("env: pinning names the variable", ENV_KEYS.allowedHosts === "WEBUI_ALLOWED_HOSTS" && ENV_KEYS.host === "WEBUI_HOST" && ENV_KEYS.publicUrl === null);
    check("env: trust proxy override", cfg.trustProxy === true && cfg.sources.trustProxy === "env");
    check("env: no-setup disables autostart", cfg.autostart === false && cfg.sources.autostart === "env");
    clearEnv();
    const fromFile = resolveConfig();
    check("file: values apply when env is clear", fromFile.host === "10.0.0.1" && fromFile.port === 5000 && fromFile.allowedHosts.join(",") === "a.lan");
  }

  // --- password hashing + redaction ----------------------------------------
  {
    applyConfigPatch({ password: "supersecret" });
    const raw = readFileSync(configPath(), "utf8");
    check("password: stored as a hash, never plaintext", !raw.includes("supersecret") && /passwordHash/.test(raw));
    const cfg = resolveConfig();
    check("password: redact marks it set", redact(cfg).passwordSet === true);
    check("password: redact never exposes the hash", !("passwordHash" in (redact(cfg) as unknown as Record<string, unknown>)));
    check("password: hash is 64 hex", /^[0-9a-f]{64}$/.test(cfg.passwordHash ?? ""));
    applyConfigPatch({ clearPassword: true });
    check("password: clear removes the hash", readFileConfig().passwordHash === null);
  }

  // --- file mode -----------------------------------------------------------
  {
    check("file: mode is 0600", (statSync(configPath()).mode & 0o777) === 0o600);
  }

  // --- validation ----------------------------------------------------------
  {
    check("validate: bad port", validatePatch({ port: 99999 }).length > 0);
    check("validate: short password", validatePatch({ password: "short" }).length > 0);
    check("validate: bad url", validatePatch({ publicUrl: "not a url" }).length > 0);
    check("validate: good patch", validatePatch({ host: "0.0.0.0", port: 8080, password: "longenough" }).length === 0);
  }

  // --- exposure ------------------------------------------------------------
  {
    check("exposure: loopback+password ok", analyzeExposure({ host: "127.0.0.1", auth: "password", allowedHosts: [] }).level === "ok");
    check("exposure: wildcard+password warn", analyzeExposure({ host: "0.0.0.0", auth: "password", allowedHosts: [] }).level === "warn");
    check("exposure: wildcard+none danger", analyzeExposure({ host: "0.0.0.0", auth: "none", allowedHosts: [] }).level === "danger");
    check("exposure: allowedHosts * warn", analyzeExposure({ host: "127.0.0.1", auth: "password", allowedHosts: ["*"] }).level === "warn");
    check("exposure: allowedHosts list warn", analyzeExposure({ host: "127.0.0.1", auth: "password", allowedHosts: ["a.lan"] }).level === "warn");
  }

  // --- mergePatch is pure --------------------------------------------------
  {
    const before = readFileConfig();
    mergePatch(before, { host: "9.9.9.9" });
    check("mergePatch: no I/O side effect", readFileConfig().host === before.host);
  }

  // --- CLI -----------------------------------------------------------------
  {
    clearEnv();
    const set = await runConfigCli(["set", "host", "192.168.1.50"]);
    check("cli: set exits 0", set === 0, String(set));
    check("cli: set wrote the file", readFileConfig().host === "192.168.1.50");
    check("cli: get exits 0", (await runConfigCli(["get"])) === 0);
    check("cli: path prints the file", (await runConfigCli(["path"])) === 0);

    // Danger (non-loopback + no auth) needs --confirm.
    check("cli: danger refused without --confirm", (await runConfigCli(["set", "auth", "none"])) === 1);
    check("cli: auth unchanged after refusal", readFileConfig().auth !== "none");
    check("cli: danger accepted with --confirm", (await runConfigCli(["set", "auth", "none", "--confirm"])) === 0);
    check("cli: auth now none", readFileConfig().auth === "none");
    check("cli: unknown key exits 1", (await runConfigCli(["set", "nope", "x"])) === 1);
    check("cli: unset resets", (await runConfigCli(["unset", "auth"])) === 0 && readFileConfig().auth === "password");
  }
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nRESULT: ${passed} pass · ${failed} fail → exit ${failed > 0 ? 1 : 0}`);
process.exit(failed > 0 ? 1 : 0);
