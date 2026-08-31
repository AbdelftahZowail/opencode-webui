/**
 * §6 verification probe: does the engine gzip the SSE stream when the client
 * sends Accept-Encoding, and do idle heartbeats survive it?
 *
 * Connects DIRECTLY to the engine (bypassing the webui proxy) with a chosen
 * Accept-Encoding and prints a timestamped line for every received chunk plus
 * the response headers.
 *
 * Known baseline: `curl -sN` (sends NO Accept-Encoding) receives heartbeats
 * every ~15s through every hop. A browser sends "gzip, deflate, br, zstd".
 * If the browser-encoding run stalls between heartbeats while identity flows,
 * compression buffering is the idle reaper — and the fix belongs in the
 * proxy (strip Accept-Encoding toward the engine).
 *
 * Usage: bun scripts/uitest/probe-gzip.ts [seconds=25] ["identity"|"browser"]
 */
import { Service } from "@opencode-ai/client/service";

const SECONDS = Number(process.argv[2] ?? 25);
const MODE = process.argv[3] ?? "browser";
const ENC =
  MODE === "identity" ? "" : MODE === "browser" ? "gzip, deflate, br, zstd" : MODE;

console.log(`probe mode=${MODE} seconds=${SECONDS} enc="${ENC || "(none)"}"`);
const ep = await Service.ensure();
console.log(`engine: ${ep.url}`);

// Bound ONLY the header phase — an abort signal that fires later would kill
// the body stream mid-probe (seen: AbortSignal.timeout aborted reads at 15s).
const headerAbort = new AbortController();
const headerTimer = setTimeout(() => headerAbort.abort(), 15_000);
let res: Response;
try {
  res = await fetch(`${ep.url}/api/event`, {
    headers: {
      ...Service.headers(ep),
      ...(ENC ? { "Accept-Encoding": ENC } : {}),
    },
    signal: headerAbort.signal,
  });
} catch (err) {
  console.log(`fetch failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
clearTimeout(headerTimer);

console.log(`status=${res.status}`);
for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);
if (!res.ok || !res.body) process.exit(1);

const t0 = Date.now();
const deadline = t0 + SECONDS * 1000;
const reader = res.body.getReader();
const decoder = new TextDecoder();
let bytes = 0;
let heartbeats = 0;
let lastByteAt = t0;
let maxGap = 0;
for (;;) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) break;
  const timeout = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => timeout.resolve("timeout"), remaining);
  let result: { done: boolean; value?: Uint8Array } | "timeout";
  try {
    result = (await Promise.race([
      reader.read() as Promise<{ done: boolean; value?: Uint8Array }>,
      timeout.promise,
    ])) as { done: boolean; value?: Uint8Array } | "timeout";
  } catch (err) {
    console.log(`read error: ${err instanceof Error ? err.message : err}`);
    break;
  }
  clearTimeout(timer);
  if (result === "timeout") break;
  if (result.done) {
    console.log("stream ended (done)");
    break;
  }
  const now = Date.now();
  maxGap = Math.max(maxGap, now - lastByteAt);
  lastByteAt = now;
  bytes += result.value?.length ?? 0;
  const text = decoder.decode(result.value, { stream: true });
  if (text.includes("heartbeat")) {
    heartbeats++;
    console.log(`+${((now - t0) / 1000).toFixed(1).padStart(6)}s heartbeat (chunk ${result.value?.length}B)`);
  } else if (!text.includes("data:")) {
    console.log(`+${((now - t0) / 1000).toFixed(1).padStart(6)}s RAW ${result.value?.length}B: ${JSON.stringify(text.slice(0, 40))}`);
  }
}
console.log(
  `total ${bytes}B, ${heartbeats} heartbeats, over ${((Date.now() - t0) / 1000).toFixed(1)}s, max inter-chunk gap ${(maxGap / 1000).toFixed(1)}s`,
);
process.exit(0);
