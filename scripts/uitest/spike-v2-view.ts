/**
 * SPIKE 3 (throwaway): follow variants + active-map entry shape + §4.4 re-samples.
 */
import { Service } from "@opencode-ai/client/service";

const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function head(sid: string): Promise<number | null> {
  const evts = await j(`/api/experimental/session/${sid}/log?follow=false`).then((r) =>
    (r.body?.data ?? []) as Array<{ type?: string; seq?: number }>,
  );
  const s = evts.find((e) => e.type === "log.synced")?.seq;
  return typeof s === "number" ? s : null;
}

const agents = (await j("/api/agent")).body?.data ?? [];
const primary = agents.find((a: { mode: string; hidden?: boolean }) => a.mode === "primary" && !a.hidden);
let model = primary?.model;
if (!model) {
  const models = (await j("/api/model")).body?.data ?? [];
  const enabled = models.filter((m: { enabled?: boolean }) => m.enabled);
  model = enabled[0] ? { providerID: enabled[0].providerID, id: enabled[0].modelID } : undefined;
}
const sid = (await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model, location: null }) })).body?.data?.id;
console.log(`[run] session ${sid}`);

// ---- RAW follow capture during a run ------------------------------------
async function rawFollow(label: string, after: string | null, ms: number) {
  const q = after === null ? "" : `after=${encodeURIComponent(after)}&`;
  const res = await fetch(`${B}/api/experimental/session/${sid}/log?${q}follow=true`, { headers: H as never });
  if (!res.ok || !res.body) {
    console.log(`[${label}] status=${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let bytes = 0;
  const t0 = Date.now();
  for (;;) {
    const remaining = ms - (Date.now() - t0);
    if (remaining <= 0) break;
    const t = Promise.withResolvers<"t">();
    const timer = setTimeout(() => t.resolve("t"), remaining);
    let chunk: { done: boolean; value?: Uint8Array } | "t";
    try {
      chunk = (await Promise.race([reader.read() as Promise<{ done: boolean; value?: Uint8Array }>, t.promise])) as { done: boolean; value?: Uint8Array } | "t";
    } catch {
      break;
    }
    clearTimeout(timer);
    if (chunk === "t" || chunk.done) break;
    bytes += chunk.value?.length ?? 0;
    if (bytes <= (chunk.value?.length ?? 0)) {
      console.log(`[${label}] FIRST BYTES: ${JSON.stringify(dec.decode(chunk.value).slice(0, 200))}`);
    } else {
      dec.decode(chunk.value, { stream: true }); // keep decoder consistent
    }
  }
  void reader.cancel().catch(() => undefined);
  console.log(`[${label}] total ${bytes}B over ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const h0 = await head(sid);
console.log(`[head] before run: ${h0}`);
const rawP = rawFollow("follow after=null", null, 20_000);
await new Promise((r) => setTimeout(r, 300));

// ---- run with active-map sampling --------------------------------------
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Write a 3-line poem about rain." }) });
const promptAt = Date.now();
let appearedAt: number | null = null;
let entryShape: Record<string, unknown> | null = null;
const waitP = fetch(`${B}/api/session/${sid}/wait`, { method: "POST", headers: H as never, signal: AbortSignal.timeout(90_000) }).then((r) => r.status).catch((e) => -1);
let waitResolved = false;
const waitStatus = await waitP;
waitResolved = true;
const waitAt = Date.now();
console.log(`[wait] status=${waitStatus} after ${((waitAt - promptAt) / 1000).toFixed(1)}s`);

// ---- active map sampling (during + after) -------------------------------
await rawP; // let the raw follow finish its window
let goneAt: number | null = null;
for (let i = 0; i < 60; i++) {
  const active = (await j("/api/session/active")).body?.data ?? {};
  const entry = active[sid];
  if (entry) {
    if (!appearedAt) appearedAt = Date.now();
    entryShape = entry as Record<string, unknown>;
    goneAt = null;
  } else if (promptAt < Date.now() && Date.now() > waitAt) {
    goneAt = Date.now();
    break;
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`[active] appeared=${appearedAt ? ((appearedAt - promptAt) / 1000).toFixed(1) + "s after prompt" : "NEVER during sampling"}`);
console.log(`[active] entry shape: ${entryShape ? JSON.stringify(entryShape).slice(0, 220) : "never captured"}`);
console.log(`[active] gone=${goneAt ? ((goneAt - waitAt) / 1000).toFixed(1) + "s after wait-resolve" : "still listed"}`);
const h1 = await head(sid);
console.log(`[head] after run: ${h1} (advanced ${h1 !== null && h0 !== null ? h1 - h0 : "?"} seqs)`);

// ---- view with the REAL captured idle counter ---------------------------
if (entryShape) {
  const idle = (entryShape as { idle?: number }).idle;
  const vr = await fetch(`${B}/api/session/${sid}/view`, { method: "POST", headers: H as never, body: JSON.stringify({ idle: idle ?? 0 }) });
  console.log(`[view] idle=${JSON.stringify(idle)} -> ${vr.status}`);
  const a2 = (await j("/api/session/active")).body?.data ?? {};
  console.log(`[view] active after view: ${a2[sid] ? "STILL LISTED" : "absent"}`);
}

// ---- second run: does the session re-appear / wait re-arm ---------------
const hBefore2 = await head(sid);
const p2 = Date.now();
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Now one more line about rain." }) });
const w2 = await fetch(`${B}/api/session/${sid}/wait`, { method: "POST", headers: H as never, signal: AbortSignal.timeout(90_000) }).then((r) => r.status).catch(() => -1);
console.log(`[run2] wait=${w2} after ${((Date.now() - p2) / 1000).toFixed(1)}s`);
for (let i = 0; i < 40; i++) {
  const active = (await j("/api/session/active")).body?.data ?? {};
  if (!active[sid]) {
    console.log(`[run2] gone from active ${((Date.now() - Date.now()) / 1).toFixed(0)}ms poll ${i}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 400));
}
const h2 = await head(sid);
console.log(`[head] after run2: ${h2} (+${h2 !== null && hBefore2 !== null ? h2 - hBefore2 : "?"})`);

await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(0);
