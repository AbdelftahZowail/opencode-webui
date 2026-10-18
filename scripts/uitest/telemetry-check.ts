#!/usr/bin/env bun
/**
 * Anonymous-telemetry contract check — privacy allowlist, gating, version
 * release-gating, the env hard-kill, and idempotent sequence/retry.
 *
 * Mirrors Quickly's tests/test_telemetry.py: it pins the exact top-level key
 * allowlist, recursively proves no fingerprinting key can appear anywhere in a
 * payload, statically forbids device-identity APIs in the module source, and
 * proves the sequence advances only after a 2xx. It also proves the 422
 * fallback: a client release that precedes a hub deploy retries once without
 * events/features instead of silently sending nothing. Everything is routed to a
 * throwaway XDG_STATE_HOME, and the only network is a local stub server, so the
 * real state file and the real hub are never touched.
 *
 *   bun run check:telemetry
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_TELEMETRY_KEY,
  MAX_CPU_COUNT,
  MAX_RAM_GB,
  PAYLOAD_KEYS,
  __setReleaseOverride,
  buildPayload,
  capacityGb,
  envDisabled,
  initTelemetry,
  instanceId,
  postPayload,
  releaseVersion,
  sendTelemetry,
  setEnabled,
  storedSeq,
  telemetryActive,
  telemetryKey,
  telemetryStatePath,
} from "../../server/telemetry";

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

// --- the frozen literal wire contract ---------------------------------------
const EXPECTED_PAYLOAD_KEYS = new Set([
  "schema_version",
  "product",
  "instance_id",
  "app_version",
  "seq",
  "sent_at",
  "deployment",
  "os",
  "arch",
  "cpu_count",
  "ram_gb",
  "heartbeat",
  "daily",
  "events",
  "features",
]);

// Key NAMES that would indicate device/host/user fingerprinting if they ever
// appeared anywhere in a payload (checked recursively, including list items).
// `instance_id` is an explicitly allowed random per-install id and is NOT in
// this list — we match keys, never naive value substrings.
const FORBIDDEN_KEYS = new Set([
  "disk_gb", "disk_usage", "disk_total", "disk_percent",
  "hostname", "host", "fqdn",
  "machine_id", "machine-id", "dmi", "serial", "board", "product_uuid",
  "mac", "mac_address", "uuid",
  "kernel", "os_version", "platform_version", "distro", "uname", "cpu_model",
  "ip", "ip_address",
  "username", "user", "home", "path", "cwd", "file",
  "env", "environment", "secret", "token", "password",
]);

const OS_FAMILIES = new Set(["linux", "windows", "macos", "other"]);
const ARCH_FAMILIES = new Set(["x86_64", "x86", "arm64", "arm", "other"]);

function collectKeys(obj: unknown, into: Set<string> = new Set()): Set<string> {
  if (obj && typeof obj === "object") {
    if (Array.isArray(obj)) {
      for (const item of obj) collectKeys(item, into);
    } else {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        into.add(key);
        collectKeys(value, into);
      }
    }
  }
  return into;
}

const tmp = mkdtempSync(join(tmpdir(), "webui-telemetry-check-"));
const saved = {
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  WEBUI_TELEMETRY: process.env.WEBUI_TELEMETRY,
  WEBUI_TELEMETRY_URL: process.env.WEBUI_TELEMETRY_URL,
  WEBUI_TELEMETRY_KEY: process.env.WEBUI_TELEMETRY_KEY,
};
process.env.XDG_STATE_HOME = tmp;

function resetState(): void {
  const p = telemetryStatePath();
  if (existsSync(p)) rmSync(p);
}

function configure(opts: {
  channel?: "dev" | "binary" | "published";
  version?: string;
  sandbox?: boolean;
  url?: string | null;
  key?: string | null;
  envKill?: boolean;
} = {}): void {
  delete process.env.WEBUI_TELEMETRY;
  if (opts.url === null) delete process.env.WEBUI_TELEMETRY_URL;
  else process.env.WEBUI_TELEMETRY_URL = opts.url ?? "http://127.0.0.1:1";
  if (opts.key === null) delete process.env.WEBUI_TELEMETRY_KEY;
  else process.env.WEBUI_TELEMETRY_KEY = opts.key ?? "test-write-key";
  if (opts.envKill) process.env.WEBUI_TELEMETRY = "false";
  initTelemetry({
    version: opts.version ?? "3.4.0",
    channel: opts.channel ?? "published",
    sandbox: opts.sandbox ?? false,
  });
  __setReleaseOverride(null);
}

try {
  // --- payload allowlist + coarse shapes -----------------------------------
  resetState();
  configure();
  const facts = { sessionsCount: 7, extensionsCount: 3, domExtensions: 1, proxyExtensions: 2 };
  initTelemetry({ version: "3.4.0", channel: "published", sandbox: false, facts: async () => facts });
  const payload = (await buildPayload()) as unknown as Record<string, unknown>;

  check("payload emits exactly the allowlist", Object.keys(payload).length === PAYLOAD_KEYS.length &&
    Object.keys(payload).every((k) => PAYLOAD_KEYS.includes(k)) &&
    PAYLOAD_KEYS.every((k) => k in payload));
  check("allowlist matches the literal contract", new Set(PAYLOAD_KEYS).size === EXPECTED_PAYLOAD_KEYS.size &&
    PAYLOAD_KEYS.every((k) => EXPECTED_PAYLOAD_KEYS.has(k)));
  check("product discriminator is opencode-webui", String(payload.product) === "opencode-webui");
  check("no disk_gb (removed as over-collection)", !("disk_gb" in payload));

  check("instance_id is an opaque 32-hex id", typeof payload.instance_id === "string" && /^[0-9a-f]{32}$/.test(payload.instance_id as string));
  check("seq starts at 1", Number(payload.seq) === 1);
  check("cpu_count within bounds", payload.cpu_count === null || (typeof payload.cpu_count === "number" && payload.cpu_count >= 1 && payload.cpu_count <= MAX_CPU_COUNT));
  check("ram_gb within bounds", payload.ram_gb === null || (typeof payload.ram_gb === "number" && payload.ram_gb >= 1 && payload.ram_gb <= MAX_RAM_GB));
  check("os is a family", OS_FAMILIES.has(String(payload.os)));
  check("arch is a family", ARCH_FAMILIES.has(String(payload.arch)));
  check("deployment is docker|bare", String(payload.deployment) === "docker" || String(payload.deployment) === "bare");

  const hb = payload.heartbeat as Record<string, unknown>;
  check("heartbeat shape", JSON.stringify(Object.keys(hb).sort()) === JSON.stringify(["extensions_count", "sessions_count", "uptime_days"]));
  check("heartbeat carries the coarse counts", Number(hb.sessions_count) === 7 && Number(hb.extensions_count) === 3);
  check("daily is empty", Array.isArray(payload.daily) && payload.daily.length === 0);
  check("events shape", Array.isArray(payload.events) && payload.events.every((e) => JSON.stringify(Object.keys(e as object).sort()) === JSON.stringify(["name", "occurred_at"])));
  check("features shape", Array.isArray(payload.features) && payload.features.every((f) => JSON.stringify(Object.keys(f as object).sort()) === JSON.stringify(["name", "used"])));
  check("features reflect facts", (payload.features as Array<{ name: string }>).map((f) => f.name).sort().join(",") === "dom_extensions,extensions,proxy_extensions");

  // --- no forbidden key at any depth ---------------------------------------
  const keys = collectKeys(payload);
  const leaked = [...keys].filter((k) => FORBIDDEN_KEYS.has(k));
  check("no forbidden key at any depth", leaked.length === 0, leaked.join(","));
  check("forbidden-key scanner is not vacuous", collectKeys({ heartbeat: { hostname: "x" } }).has("hostname"));

  // --- no planted private value survives -----------------------------------
  const serialized = JSON.stringify(payload).toLowerCase();
  const forbiddenValues = [tmp.toLowerCase(), (process.env.HOME ?? "/home/__none__").toLowerCase(), "test-write-key"];
  check("no private value survives serialization", !forbiddenValues.some((v) => v.length > 3 && serialized.includes(v)));

  // --- capacity rounding ----------------------------------------------------
  const gib = 1024 ** 3;
  check("capacityGb rounds up + clamps", capacityGb(0, 1024) === 1 && capacityGb(gib, 1024) === 1 && capacityGb(gib + 1, 1024) === 2 && capacityGb(7 * gib, 4) === 4 && capacityGb(10 ** 15, MAX_RAM_GB) === MAX_RAM_GB);

  // --- version release-gating ----------------------------------------------
  configure({ channel: "dev" });
  check("dev checkout is not a release", releaseVersion() === null && telemetryActive() === false);
  configure({ channel: "binary" });
  check("compiled binary is not a release", releaseVersion() === null && telemetryActive() === false);
  configure({ channel: "published" });
  check("published release is sendable", releaseVersion() === "3.4.0" && telemetryActive() === true);
  configure({ channel: "published", version: "unknown" });
  check("non-x.y.z version is refused", releaseVersion() === null && telemetryActive() === false);
  configure({ channel: "published", sandbox: true });
  check("sandbox never sends", releaseVersion() === null && telemetryActive() === false);

  // --- env hard-kill + unset url/key ---------------------------------------
  configure({ envKill: true });
  check("WEBUI_TELEMETRY=false is a hard kill", envDisabled() === true && telemetryActive() === false);
  // The hub URL has a public baked default; the KEY may be baked into the
  // artifact at release time (`dist/telemetry-key.json`). So "unset env" alone
  // no longer means inert — assert the documented resolution order here, and
  // prove the inert/active pair deterministically further down (the block that
  // stashes any real baked file).
  configure({ key: null });
  const bakedNow = (() => {
    try {
      const raw = JSON.parse(
        readFileSync(join(import.meta.dir, "..", "..", "dist", "telemetry-key.json"), "utf8"),
      ) as { key?: unknown };
      return typeof raw.key === "string" ? raw.key.trim() : "";
    } catch {
      return "";
    }
  })();
  check(
    "unset env falls through to the release-baked key (none in a checkout)",
    telemetryKey() === bakedNow,
    `env unset ⇒ ${telemetryKey().length} chars, baked file ${bakedNow.length}`,
  );
  // And with no URL at all, a send is a no-op (never a network call).
  check("empty URL prevents a send", (await postPayload(await buildPayload(), { url: "", key: "k" })) === false);

  // --- a gated-off send performs NO network --------------------------------
  configure({ channel: "dev" });
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error("network should not be touched");
  }) as unknown as typeof fetch;
  const gatedResult = await sendTelemetry();
  globalThis.fetch = realFetch;
  check("dev send is inert and performs no network", gatedResult === false && networkCalls === 0);

  configure({ envKill: true });
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error("network should not be touched");
  }) as unknown as typeof fetch;
  const killedResult = await sendTelemetry();
  globalThis.fetch = realFetch;
  check("env-killed send is inert and performs no network", killedResult === false && networkCalls === 0);

  // --- sequence advances ONLY after 2xx (idempotent retry) -----------------
  resetState();
  configure();
  initTelemetry({ version: "3.4.0", channel: "published", sandbox: false, facts: async () => facts });
  const statuses = [500, 202];
  const seen: Array<Record<string, unknown>> = [];
  const stub = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push(body);
      const status = statuses.shift() ?? 202;
      return new Response(JSON.stringify({ status: "ok" }), { status });
    },
  });
  process.env.WEBUI_TELEMETRY_URL = `http://127.0.0.1:${stub.port}`;
  process.env.WEBUI_TELEMETRY_KEY = "test-write-key";
  __setReleaseOverride(true);

  const first = await sendTelemetry();
  check("failed (500) send returns false", first === false);
  check("seq NOT advanced after 500", storedSeq() === 0);
  const second = await sendTelemetry();
  check("accepted (202) send returns true", second === true);
  check("seq advanced after 202", storedSeq() === 1);
  check("retry reuses the same seq (idempotent)", seen.length === 2 && Number(seen[0]?.seq) === 1 && Number(seen[1]?.seq) === 1);
  check("the stub received the exact allowlist", seen.every((p) => Object.keys(p).every((k) => PAYLOAD_KEYS.includes(k))));
  check("the stub received product + no forbidden keys", String(seen[0]?.product) === "opencode-webui" && ![...collectKeys(seen[0])].some((k) => FORBIDDEN_KEYS.has(k)));

  // --- instance id is durable + stable -------------------------------------
  const idA = instanceId();
  const idB = instanceId();
  check("instance id is stable across reads", idA === idB && /^[0-9a-f]{32}$/.test(idA));

  // --- opt-out toggle -------------------------------------------------------
  setEnabled(false);
  check("toggle off disables sending", telemetryActive() === false && storedSeq() === 1);
  setEnabled(true);
  check("toggle on re-enables sending", telemetryActive() === true);
  check("env kill still wins after toggle on", (() => {
    process.env.WEBUI_TELEMETRY = "false";
    const off = telemetryActive() === false;
    delete process.env.WEBUI_TELEMETRY;
    return off;
  })());

  // --- a NEW client vs an OLDER hub: 422 retries ONCE without the gated lists
  // A client release can precede a hub deploy; the hub gates event/feature
  // names per product and answers 422 for names it does not know yet. The
  // retry drops ONLY events+features, so the version/scale heartbeat still
  // lands (fail-open — never a silent "sent nothing").
  resetState();
  const vocab: Array<Record<string, unknown>> = [];
  const vocabStub = Bun.serve({
    port: 0,
    fetch: async (req) => {
      vocab.push((await req.json()) as Record<string, unknown>);
      const status = vocab.length === 1 ? 422 : 202;
      return new Response(JSON.stringify({ detail: "unknown opencode-webui feature" }), { status });
    },
  });
  process.env.WEBUI_TELEMETRY_URL = `http://127.0.0.1:${vocabStub.port}`;
  process.env.WEBUI_TELEMETRY_KEY = "test-write-key";
  const retried = await sendTelemetry();
  vocabStub.stop(true);
  check("422 is retried and the send succeeds", retried === true);
  check("422 retry is exactly one extra request", vocab.length === 2);
  check("422 retry reuses the same seq (idempotent)", Number(vocab[0]?.seq) === 1 && Number(vocab[1]?.seq) === 1);
  check(
    "422 retry drops only events+features",
    ((vocab[0]?.events as unknown[]) ?? []).length > 0 &&
      ((vocab[0]?.features as unknown[]) ?? []).length > 0 &&
      ((vocab[1]?.events as unknown[]) ?? []).length === 0 &&
      ((vocab[1]?.features as unknown[]) ?? []).length === 0 &&
      vocab[1]?.product === "opencode-webui" &&
      vocab[1]?.app_version === "3.4.0",
  );
  check("422 retry keeps the allowlist", vocab.every((p) => Object.keys(p).every((k) => PAYLOAD_KEYS.includes(k))));
  check("seq advanced after the 422 fallback", storedSeq() === 1);

  // --- a 422 with nothing to drop must NOT retry forever -------------------
  resetState();
  let always422 = 0;
  const hardStub = Bun.serve({
    port: 0,
    fetch: async () => {
      always422++;
      return new Response(JSON.stringify({ detail: "nope" }), { status: 422 });
    },
  });
  process.env.WEBUI_TELEMETRY_URL = `http://127.0.0.1:${hardStub.port}`;
  const hardResult = await sendTelemetry();
  hardStub.stop(true);
  check("a persistent 422 does not loop (2 attempts, then false)", hardResult === false && always422 === 2);

  stub.stop(true);

  // --- static: no device-identity APIs in the module -----------------------
  const source = readFileSync(join(import.meta.dir, "..", "..", "server", "telemetry.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const banned = [
    "gethostname", "hostname", "networkInterfaces", "os.userInfo", "userInfo(",
    "/etc/machine-id", "machine-id", "machine_id", "getmac", "serialnumber",
    "process.env.HOSTNAME",
  ];
  const hit = banned.filter((token) => code.includes(token));
  check("no device-identity API in telemetry.ts", hit.length === 0, hit.join(","));
  check("static scan is not vacuous (sees real code)", code.includes("osPlatform") && code.includes("totalmem"));

  // --- static: no credential/URL leaks into the browser bundle -------------
  const browserLeak = await grepRepo(join(import.meta.dir, "..", "..", "src"), [
    "telemetry.shortformfunnels",
    "X-Quickly-Key",
    "WEBUI_TELEMETRY_KEY",
  ]);
  check("browser src holds no telemetry credential/URL", browserLeak.length === 0, browserLeak.join(","));
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The release-baked key: env → dist/telemetry-key.json → "" (never in git)
//
// Deterministic in BOTH states: any key file the working tree happens to carry
// (a real publish leaves one behind) is stashed first and restored afterwards,
// so this proves the fix AND does not fail merely because dist/ was published.
// ---------------------------------------------------------------------------
{
  const savedKey = process.env.WEBUI_TELEMETRY_KEY;
  const dir = mkdtempSync(join(tmpdir(), "webui-key-"));
  const bakedFile = join(import.meta.dir, "..", "..", "dist", "telemetry-key.json");
  const stashed = join(dir, "stashed.json");
  const hadBaked = existsSync(bakedFile);
  if (hadBaked) renameSync(bakedFile, stashed);
  try {
    check("no ingest key is committed in the source", DEFAULT_TELEMETRY_KEY === "");

    delete process.env.WEBUI_TELEMETRY_KEY;
    __setReleaseOverride(true);
    check(
      "checkout (no env, no baked file) ⇒ no key, and INERT — the 3.4.0/3.4.1 state",
      telemetryKey() === "" && telemetryActive() === false,
      `key=${telemetryKey().length} chars, active=${telemetryActive()}`,
    );

    mkdirSync(dirname(bakedFile), { recursive: true });
    writeFileSync(bakedFile, `${JSON.stringify({ key: "CHECK-BAKED-KEY" })}\n`, { mode: 0o600 });
    check("a release-baked key is used with no env", telemetryKey() === "CHECK-BAKED-KEY", telemetryKey());
    check("…and the release is ACTIVE (the fix)", telemetryActive() === true);
    process.env.WEBUI_TELEMETRY_KEY = "env-wins-key";
    check("the env override still wins over the baked key", telemetryKey() === "env-wins-key", telemetryKey());
    delete process.env.WEBUI_TELEMETRY_KEY;
    writeFileSync(bakedFile, "{ not json");
    check("a corrupt baked file is fail-open (no key, no throw)", telemetryKey() === "");
    rmSync(bakedFile, { force: true });

    // The generator is the guard that stops a release from silently shipping
    // inert (exactly what 3.4.0/3.4.1 did): it MUST refuse an empty key.
    const gen = join(import.meta.dir, "..", "gen-telemetry-key.ts");
    const out = join(dir, "telemetry-key.json");
    const bare = Bun.spawnSync([process.execPath, "run", gen, "--out", out], {
      env: { ...process.env, WEBUI_TELEMETRY_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    check(
      "gen:telemetry-key REFUSES to bake without a key",
      bare.exitCode !== 0 && !existsSync(out),
      `exit ${bare.exitCode}`,
    );
    check("…and says why", bare.stderr.toString().includes("WEBUI_TELEMETRY_KEY"));

    const baked = Bun.spawnSync([process.execPath, "run", gen, "--out", out], {
      env: { ...process.env, WEBUI_TELEMETRY_KEY: "baked-test-key" },
      stdout: "pipe",
      stderr: "pipe",
    });
    check(
      "gen:telemetry-key writes the key when given one",
      baked.exitCode === 0 && (JSON.parse(readFileSync(out, "utf8")) as { key?: string }).key === "baked-test-key",
      `exit ${baked.exitCode}`,
    );
    check(
      "the baked key file is 0600 (never world-readable)",
      (statSync(out).mode & 0o777) === 0o600,
      (statSync(out).mode & 0o777).toString(8),
    );
    check("the generator never echoes the key", !baked.stdout.toString().includes("baked-test-key"));
  } finally {
    rmSync(bakedFile, { force: true });
    if (hadBaked) renameSync(stashed, bakedFile);
    if (savedKey === undefined) delete process.env.WEBUI_TELEMETRY_KEY;
    else process.env.WEBUI_TELEMETRY_KEY = savedKey;
    __setReleaseOverride(null);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function grepRepo(dir: string, tokens: string[]): Promise<string[]> {
  const { readdirSync, statSync } = await import("node:fs");
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) {
        const text = readFileSync(p, "utf8");
        for (const t of tokens) if (text.includes(t)) hits.push(`${p}:${t}`);
      }
    }
  };
  walk(dir);
  return hits;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
