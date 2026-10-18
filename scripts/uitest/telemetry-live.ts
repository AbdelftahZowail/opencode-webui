#!/usr/bin/env bun
/**
 * Live telemetry send — proves a real payload is POSTed and the hub accepts it.
 *
 *   WEBUI_TELEMETRY_URL=... WEBUI_TELEMETRY_KEY=... bun run scripts/uitest/telemetry-live.ts [--compat]
 *
 * `--compat` sends a payload the CURRENT hub schema accepts (webui-only
 * event/feature names cleared); without it the FULL payload is sent through the
 * real gated path (`sendTelemetry`) — use that against a hub running the
 * proposed per-product schemas. Never prints the key. Uses a throwaway state
 * dir, so the real install state is untouched.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAYLOAD_KEYS,
  __setReleaseOverride,
  buildPayload,
  initTelemetry,
  postPayload,
  sendTelemetry,
  telemetryKey,
  telemetryUrl,
} from "../../server/telemetry";

const compat = process.argv.includes("--compat");
const tmp = mkdtempSync(join(tmpdir(), "webui-telemetry-live-"));
process.env.XDG_STATE_HOME = tmp;

const url = telemetryUrl();
const key = telemetryKey();
if (!url || !key) {
  console.error("telemetry-live: WEBUI_TELEMETRY_URL and WEBUI_TELEMETRY_KEY are required");
  process.exit(2);
}

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
initTelemetry({ version, channel: "published", sandbox: false, facts: async () => ({ sessionsCount: 3, extensionsCount: 2, domExtensions: 1, proxyExtensions: 1 }) });
__setReleaseOverride(true);

const host = new URL(url).host;
console.log(`telemetry-live: target ${host} · version ${version} · mode ${compat ? "compat" : "full"}`);

let ok = false;
try {
  if (compat) {
    const payload = await buildPayload();
    // The CURRENT hub has no per-product enums, so webui-only event/feature
    // names are rejected; clear them for this compatibility probe. `product`
    // and the coarse heartbeat ride along (unknown fields are ignored).
    payload.events = [];
    payload.features = [];
    ok = await postPayload(payload);
    console.log(`telemetry-live: payload keys [${Object.keys(payload).filter((k) => PAYLOAD_KEYS.includes(k)).join(", ")}]`);
  } else {
    const payload = await buildPayload();
    console.log(`telemetry-live: payload keys [${Object.keys(payload).filter((k) => PAYLOAD_KEYS.includes(k)).join(", ")}]`);
    console.log(`telemetry-live: product=${payload.product} events=[${payload.events.map((e) => e.name).join(",")}] features=[${payload.features.map((f) => f.name).join(",")}]`);
    ok = await sendTelemetry();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`telemetry-live: ${ok ? "ACCEPTED (2xx)" : "REJECTED / not sent"}`);
process.exit(ok ? 0 : 1);
