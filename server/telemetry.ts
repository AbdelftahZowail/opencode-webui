/**
 * Anonymous usage telemetry for self-hosted opencode-webui installs.
 *
 * Sends ONE small heartbeat from this proxy to the shared telemetry hub. It is
 * fail-open: it never blocks boot, never throws into the caller, and does
 * nothing when disabled or unconfigured. There is no engine/DB dependency —
 * every value comes from this process's own coarse facts (see `TelemetryFacts`).
 *
 * The payload is deliberately coarse — install scale only: a random per-install
 * id (used just to de-duplicate heartbeats), the app version, deployment form,
 * OS/CPU/arch *family*, RAM rounded UP to whole GB, CPU count, uptime, and
 * aggregate counts (sessions/extensions). It never carries hostnames, exact
 * OS/kernel/disk details, environment variables, IP addresses, file paths,
 * session titles, prompts, message content, model outputs, or any other user
 * content. `buildPayload` is the single source of truth for the wire format and
 * `PAYLOAD_KEYS` is the explicit allowlist; `scripts/uitest/telemetry-check.ts`
 * pins both (mirroring Quickly's tests/test_telemetry.py).
 *
 * Disable:
 *   * in the app  — Settings › Telemetry toggle (persisted here)
 *   * environment — WEBUI_TELEMETRY=false (wins over the toggle)
 * Both default to enabled (opt-out); an unset URL/key also prevents sending.
 * Point it at a hub (dev/testing):
 *   WEBUI_TELEMETRY_URL / WEBUI_TELEMETRY_KEY
 *
 * The hub route is `POST {url}/v1/telemetry` with an `X-Quickly-Key` header.
 * That header is a low-privilege ingestion filter, NOT a security boundary (the
 * same model as Quickly), so a baked default key is acceptable.
 *
 * A hub that does not yet know this product's event/feature names answers 422;
 * `postPayload` retries once with those two lists empty so the version/scale
 * heartbeat still lands (see `postPayload`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { arch as osArch, cpus, homedir, platform as osPlatform, totalmem } from "node:os";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;
/** Product discriminator — the hub separates installs of different apps by it. */
export const PRODUCT = "opencode-webui";

/**
 * Public hub endpoint and the ingest key. The URL is public by design. The key
 * is a public ingestion filter, not an admin credential or a security boundary
 * (release automation may bake one); an empty key simply disables sending.
 */
export const DEFAULT_TELEMETRY_URL = "https://telemetry.shortformfunnels.com";
export const DEFAULT_TELEMETRY_KEY = "";

/** One heartbeat per process at a time; the persisted sequence is the truth. */
export const REQUEST_TIMEOUT_MS = 8_000;
export const HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h (Quickly parity)
export const FIRST_RUN_DELAY_MS = 45_000; // first send +45s (Quickly parity)

// Upper bounds taken from the hub wire schema (its own maxima for these
// fields). Values are reported as-is; these only stop an extreme machine from
// failing validation. RAM is rounded up to whole GB for coarseness.
export const MAX_CPU_COUNT = 1024;
export const MAX_RAM_GB = 4096;

// Family-level allowlists for the only two platform values on the wire.
// Anything unrecognised collapses to "other", so an unexpected platform string
// can never leak a raw, versioned value.
const OS_FAMILIES: Record<string, string> = { linux: "linux", darwin: "macos", win32: "windows" };
const ARCH_FAMILIES: Record<string, string> = {
  x64: "x86_64",
  amd64: "x86_64",
  ia32: "x86",
  x86: "x86",
  arm64: "arm64",
  aarch64: "arm64",
  arm: "arm",
};

/**
 * The complete set of top-level keys `buildPayload` may emit. Tests assert both
 * that a built payload matches this set exactly and that this set matches the
 * literal contract, so the wire format cannot drift silently.
 */
export const PAYLOAD_KEYS: readonly string[] = Object.freeze([
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

/** One-time milestones this client can honestly observe. */
export const ACTIVATION_EVENTS = Object.freeze(["setup_completed"] as const);
/** Coarse "was this capability used" flags derivable from proxy-local facts. */
export const FEATURE_NAMES = Object.freeze(["extensions", "dom_extensions", "proxy_extensions"] as const);

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$/;

/**
 * Coarse, non-identifying facts the proxy can observe without touching user
 * content. Supplied by `server/index.ts` (which owns extension discovery and
 * can best-effort count engine sessions); the module itself stays engine-free
 * and unit-testable.
 */
export interface TelemetryFacts {
  /** Engine session count — a coarse scale signal; null when unobservable. */
  sessionsCount: number | null;
  /** Installed extension folders (count only). */
  extensionsCount: number;
  /** Installed extensions with a DOM stratum. */
  domExtensions: number;
  /** Installed extensions with a proxy stratum (server.ts). */
  proxyExtensions: number;
}

const EMPTY_FACTS: TelemetryFacts = {
  sessionsCount: null,
  extensionsCount: 0,
  domExtensions: 0,
  proxyExtensions: 0,
};

export interface TelemetryPayload {
  schema_version: number;
  product: string;
  instance_id: string;
  app_version: string;
  seq: number;
  sent_at: string;
  deployment: string;
  os: string;
  arch: string;
  cpu_count: number | null;
  ram_gb: number | null;
  heartbeat: {
    sessions_count: number | null;
    extensions_count: number;
    uptime_days: number;
  };
  daily: unknown[];
  events: Array<{ name: string; occurred_at: string }>;
  features: Array<{ name: string; used: boolean }>;
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

let appVersion = "0.0.0";
let channel: "dev" | "binary" | "published" = "published";
let sandbox = false;
let factsProvider: () => Promise<TelemetryFacts> = async () => EMPTY_FACTS;

/**
 * Testing/CI only: force the release gate on (a real "published" run is
 * otherwise required). `null` restores channel detection. Never set in prod.
 */
let releaseOverride: boolean | null = null;

export interface TelemetryInit {
  /** Version from package.json, read once at boot. */
  version: string;
  /** Update channel — only "published" (npm-installed) may send. */
  channel: "dev" | "binary" | "published";
  /** Sandbox instances are throwaway and never send. */
  sandbox: boolean;
  /** Coarse facts collector (extension counts, session count). */
  facts?: () => Promise<TelemetryFacts>;
}

export function initTelemetry(opts: TelemetryInit): void {
  appVersion = opts.version;
  channel = opts.channel;
  sandbox = opts.sandbox;
  if (opts.facts) factsProvider = opts.facts;
}

/** CI/test hook: pin the release gate instead of relying on a published run. */
export function __setReleaseOverride(value: boolean | null): void {
  releaseOverride = value;
}

export function appVersionString(): string {
  return appVersion;
}

// ---------------------------------------------------------------------------
// Durable state (instance id, monotonic seq, opt-out toggle)
// ---------------------------------------------------------------------------

function stateDir(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-webui");
}

/** Durable state file (mode 0600). Never contains user content. */
export function telemetryStatePath(): string {
  return join(stateDir(), "telemetry.json");
}

interface TelemetryState {
  instanceId: string;
  seq: number;
  enabled: boolean;
  firstSeen: string;
}

/**
 * Read state, creating it on first use. A parse/shape failure degrades to a
 * fresh state rather than throwing — telemetry must never break the proxy.
 */
function readState(): TelemetryState {
  const fresh: TelemetryState = {
    instanceId: randomUUID().replace(/-/g, ""),
    seq: 0,
    enabled: true,
    firstSeen: new Date().toISOString(),
  };
  try {
    const raw = JSON.parse(readFileSync(telemetryStatePath(), "utf8")) as Partial<TelemetryState>;
    if (typeof raw.instanceId === "string" && /^[0-9a-f]{32}$/i.test(raw.instanceId)) {
      fresh.instanceId = raw.instanceId.toLowerCase();
    }
    if (typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0) fresh.seq = raw.seq;
    if (typeof raw.enabled === "boolean") fresh.enabled = raw.enabled;
    if (typeof raw.firstSeen === "string" && raw.firstSeen.length > 0) fresh.firstSeen = raw.firstSeen;
  } catch {
    /* absent or corrupt — start fresh (id is regenerated only when unreadable) */
  }
  return fresh;
}

function writeState(state: TelemetryState): void {
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${telemetryStatePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, telemetryStatePath()); // atomic replace
    chmodSync(telemetryStatePath(), 0o600);
  } catch {
    /* fail-open: a read-only state dir just means no persistence */
  }
}

/** Opaque random id, stable for the life of this install's state file. */
export function instanceId(): string {
  const state = readState();
  if (!existsSync(telemetryStatePath())) writeState(state);
  return state.instanceId;
}

export function storedSeq(): number {
  return readState().seq;
}

export function enabled(): boolean {
  return readState().enabled;
}

export function setEnabled(value: boolean): void {
  const state = readState();
  state.enabled = value;
  writeState(state);
}

/** ISO timestamp of the first observed run (the one activation milestone). */
export function firstSeen(): string {
  const state = readState();
  if (!existsSync(telemetryStatePath())) writeState(state);
  return state.firstSeen;
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/** `WEBUI_TELEMETRY=false` (or 0/no/off) is a hard kill that wins over the toggle. */
export function envDisabled(): boolean {
  const value = (process.env.WEBUI_TELEMETRY ?? "").trim().toLowerCase();
  return value === "false" || value === "0" || value === "no" || value === "off";
}

export function telemetryUrl(): string {
  return (process.env.WEBUI_TELEMETRY_URL || DEFAULT_TELEMETRY_URL).trim().replace(/\/+$/, "");
}

export function telemetryKey(): string {
  return (process.env.WEBUI_TELEMETRY_KEY || DEFAULT_TELEMETRY_KEY).trim();
}

/**
 * Only a published release with a real `x.y.z` version may send. A dev
 * checkout, a compiled binary, and a sandbox are all inert — the webui
 * equivalent of Quickly's dev `_app_version() -> "unknown"` refusal.
 */
export function releaseVersion(): string | null {
  if (releaseOverride === null) {
    if (sandbox || channel !== "published") return null;
  }
  return VERSION_RE.test(appVersion) ? appVersion : null;
}

/** True only when enabled, configured, a release, and not env-disabled. */
export function telemetryActive(): boolean {
  if (envDisabled() || !enabled()) return false;
  if (releaseVersion() === null) return false;
  return Boolean(telemetryUrl() && telemetryKey());
}

// ---------------------------------------------------------------------------
// Facts + payload
// ---------------------------------------------------------------------------

function deployment(): string {
  return existsSync("/.dockerenv") ? "docker" : "bare";
}

function osFamily(): string {
  return OS_FAMILIES[osPlatform().trim().toLowerCase()] ?? "other";
}

function archFamily(): string {
  return ARCH_FAMILIES[osArch().trim().toLowerCase()] ?? "other";
}

/** Round bytes up to a coarse whole-GB value, with a hard cap and a floor of 1. */
export function capacityGb(value: number, maximumGb: number): number {
  const gb = Math.floor(Math.max(value, 0) / 1024 ** 3) + (Math.max(value, 0) % 1024 ** 3 === 0 ? 0 : 1);
  return Math.min(Math.max(gb, 1), maximumGb);
}

function cpuCount(): number | null {
  const count = cpus().length;
  if (!count || count < 1) return null;
  return Math.min(count, MAX_CPU_COUNT);
}

function ramGb(): number | null {
  try {
    return capacityGb(totalmem(), MAX_RAM_GB);
  } catch {
    return null;
  }
}

function uptimeDays(): number {
  return Math.max(0, Math.floor(process.uptime() / 86_400));
}

function clampCount(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), maximum);
}

/**
 * Assemble one payload from the explicit allowlist documented above.
 *
 * This function is the single source of truth for what leaves the machine.
 * Only coarse, non-identifying fields may be added here, and the privacy
 * statement at the top of this module plus `PAYLOAD_KEYS` must be updated in
 * the same change.
 */
export async function buildPayload(): Promise<TelemetryPayload> {
  let facts = EMPTY_FACTS;
  try {
    facts = await factsProvider();
  } catch {
    /* fail-open: coarse facts are best-effort */
  }
  const features: Array<{ name: string; used: boolean }> = [];
  if (facts.extensionsCount > 0) features.push({ name: "extensions", used: true });
  if (facts.domExtensions > 0) features.push({ name: "dom_extensions", used: true });
  if (facts.proxyExtensions > 0) features.push({ name: "proxy_extensions", used: true });

  return {
    schema_version: SCHEMA_VERSION,
    product: PRODUCT,
    instance_id: instanceId(),
    app_version: appVersion,
    seq: storedSeq() + 1,
    sent_at: new Date().toISOString(),
    deployment: deployment(),
    os: osFamily(),
    arch: archFamily(),
    cpu_count: cpuCount(),
    ram_gb: ramGb(),
    heartbeat: {
      sessions_count: facts.sessionsCount === null ? null : clampCount(facts.sessionsCount, 1_000_000),
      extensions_count: clampCount(facts.extensionsCount, 10_000),
      uptime_days: uptimeDays(),
    },
    daily: [],
    events: [{ name: "setup_completed", occurred_at: firstSeen() }],
    features,
  };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

let inFlight = false;

/**
 * POST one already-built payload. Never throws; returns true on 2xx.
 * `fetchImpl` is injectable for tests.
 *
 * A client release can precede a hub deploy: the hub gates event/feature names
 * against a per-product vocabulary, so a NEW client talking to an OLDER hub can
 * be rejected with 422. When that happens and the payload carried events or
 * features, retry ONCE without them. The heartbeat (version, scale, platform)
 * still lands — fail-open, and never a silent "sent nothing".
 */
export async function postPayload(
  payload: TelemetryPayload,
  opts: { url?: string; key?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const url = (opts.url ?? telemetryUrl()).trim().replace(/\/+$/, "");
  const key = (opts.key ?? telemetryKey()).trim();
  if (!url || !key) return false;
  const doFetch = opts.fetchImpl ?? fetch;

  const post = async (body: TelemetryPayload): Promise<Response | null> => {
    try {
      return await doFetch(`${url}/v1/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Quickly-Key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  };

  const ok = (res: Response | null) => !!res && res.status >= 200 && res.status < 300;

  const res = await post(payload);
  if (ok(res)) return true;

  if (res?.status === 422 && (payload.events.length > 0 || payload.features.length > 0)) {
    // Vocabulary mismatch with this hub: drop the two gated lists and retry once.
    return ok(await post({ ...payload, events: [], features: [] }));
  }
  return false;
}

/**
 * Build and send one payload. Never raises; returns true on success.
 *
 * The sequence is advanced only after the hub has accepted the request, so a
 * lost response causes a replay with the same sequence, which the hub
 * de-duplicates rather than double-counting.
 */
export async function sendTelemetry(): Promise<boolean> {
  if (!telemetryActive()) return false;
  if (inFlight) return false;
  inFlight = true;
  try {
    let payload: TelemetryPayload;
    try {
      payload = await buildPayload();
    } catch {
      return false;
    }
    const ok = await postPayload(payload);
    if (ok) {
      const state = readState();
      state.seq = payload.seq;
      writeState(state);
    }
    return ok;
  } finally {
    inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Scheduler (proxy-side): first send +45s, then every 12h.
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the heartbeat timer. Idempotent. Silent when telemetry is inactive at
 * boot — the toggle is read fresh on every tick, so enabling it later works
 * without a restart. Returns a stop function.
 */
export function startTelemetryHeartbeat(log: (message: string) => void = () => {}): () => void {
  if (timer) return stop;
  const fire = () => {
    void sendTelemetry().then((ok) => {
      if (ok) log("telemetry: heartbeat sent");
    });
  };
  const first = setTimeout(fire, FIRST_RUN_DELAY_MS);
  first.unref?.();
  timer = setInterval(fire, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return stop;
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
