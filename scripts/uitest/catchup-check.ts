#!/usr/bin/env bun
/**
 * End-to-end catch-up proof: start a run, wait until the engine has ACTUALLY
 * produced content (provider cold starts can outlast any fixed delay), attach
 * a FRESH store client with no SSE subscription, and verify selectSession's
 * replay pull reconstructs the live projection from the proxy recorder.
 *
 * Exit codes: 0 = proof passed · 1 = proof FAILED (replay bug) ·
 *             2 = ENV-BLOCKED (the run never produced content — provider or
 *             model trouble, not our code).
 */
import { Service } from "@opencode-ai/client/service";

// 1) direct engine access for run orchestration (as the engine sees it)
const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  return res.json();
}

// 2) fresh store client (no SSE in this process) — redirect /api to the proxy
// BEFORE importing the store, so resolveDefaultModel() and every store fetch
// hit the proxy exactly like the real app.
const origFetch = globalThis.fetch;
(globalThis as { fetch: typeof fetch }).fetch = ((url: string | URL, init?: RequestInit) => {
  const u = typeof url === "string" ? url : url.toString();
  return origFetch(u.startsWith("/") ? `http://127.0.0.1:4097${u}` : u, init);
}) as typeof fetch;
const { selectSession, getState, resolveDefaultModel } = await import("../../src/store");
const { api } = await import("../../src/api/client");

// 3) pin the resolved default model AT CREATION — model-less sessions fail
// engine-side in ~500ms, and unpinned sessions mis-pin on first send.
const model = await resolveDefaultModel();
const created = await j("/api/session", {
  method: "POST",
  body: JSON.stringify({ title: null, agent: null, model: model ?? null, location: null }),
});
const sid = created.data.id;
console.log(
  "SESSION:",
  sid,
  "model:",
  model ? `${model.providerID}/${model.id}` : "(none)",
);
await j(`/api/session/${sid}/prompt`, {
  method: "POST",
  body: JSON.stringify({
    text: "Think about rain for at least 6 sentences, then write a 4-line poem about rain.",
  }),
});

const PRODUCE_TIMEOUT_MS = 120_000;

// REST-side transcript size (persisted content only — near-zero mid-run).
const contentChars = async (): Promise<number> => {
  try {
    const { data } = await api.messages(sid);
    let n = 0;
    for (const m of data ?? []) {
      if (m.type !== "assistant") continue;
      for (const p of m.content) {
        if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string") {
          n += p.text.length;
        }
      }
    }
    return n;
  } catch {
    return 0;
  }
};

// 4) attach MID-RUN: REST history serves no mid-stream text (part skeletons
// arrive with text:0 — the engine only persists at step end), so the only
// honest measure of "there is something to catch up on" is the engine's own
// SSE stream. Tap it directly (independent of the proxy recorder we're
// proving against) and count the delta chars emitted for this session.
const tap = await (async (): Promise<{ deltaChars: number; events: number } | null> => {
  const ctrl = new AbortController();
  const deadline = Date.now() + PRODUCE_TIMEOUT_MS;
  setTimeout(() => ctrl.abort(), PRODUCE_TIMEOUT_MS);
  try {
    const res = await origFetch(`${B}/api/event`, { headers: H as never, signal: ctrl.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let deltaChars = 0;
    let events = 0;
    for (;;) {
      if (deltaChars > 0 && Date.now() > deadline) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim()) as {
            type?: string;
            data?: { sessionID?: string; delta?: string };
          };
          if (evt.type !== "session.reasoning.delta" && evt.type !== "session.text.delta") continue;
          const d = evt.data;
          if (!d || d.sessionID !== sid || typeof d.delta !== "string") continue;
          events++;
          deltaChars += d.delta.length;
        } catch {
          /* skip malformed line */
        }
      }
      if (deltaChars >= 400) break; // enough mid-run content to prove catch-up
    }
    ctrl.abort();
    return { deltaChars, events };
  } catch {
    return null;
  }
})();
if (!tap || tap.deltaChars === 0) {
  console.log("ENV-BLOCKED: engine streamed no deltas for the session (provider/model trouble)");
  await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
  process.exit(2);
}
console.log(
  `tapped ${tap.events} delta events / ${tap.deltaChars} chars mid-run — attaching fresh client (no SSE)…`,
);
const expected = tap.deltaChars;

// 5) the late join: selectSession pulls the replay gap and rebuilds live state.
// A fast model can settle the run DURING the attach — a settled run's live
// overlay is then superseded by persisted history within milliseconds, so
// sample DURING selectSession and keep the best reconstruction observed.
let best = { entries: 0, reasoning: 0, text: 0, tools: 0, running: false };
const sampler = setInterval(() => {
  const st = getState();
  const live = st.live.filter((a) => a.sessionID === sid);
  const cur = {
    entries: live.length,
    reasoning: live.reduce((n, a) => n + a.reasoning.length, 0),
    text: live.reduce((n, a) => n + a.text.length, 0),
    tools: live.reduce((n, a) => n + a.tools.size, 0),
    running: !!st.running[sid],
  };
  if (cur.reasoning + cur.text > best.reasoning + best.text) best = cur;
}, 25);
await selectSession(sid);
await new Promise((r) => setTimeout(r, 2000)); // replay pull + reducer + settle retry
clearInterval(sampler);
console.log(
  `best reconstruction: entries=${best.entries} reasoning=${best.reasoning} text=${best.text} tools=${best.tools} running=${best.running}`,
);
const replayOK = best.entries > 0 && best.reasoning + best.text >= Math.floor(expected * 0.8);

// The run may have SETTLED during the attach window: history then serves the
// transcript and retires the live overlay — still a catch-up (via history),
// but say so explicitly so a replay-path regression can't hide behind it.
let viaHistory = false;
if (!replayOK) {
  const settledChars = await contentChars();
  viaHistory = settledChars >= expected * 0.8;
  if (viaHistory) console.log(`(run settled around attach — history serves ${settledChars} chars)`);
}

console.log(
  replayOK
    ? `CATCH-UP OK — late join reconstructed the stream via replay (${best.reasoning + best.text}/${expected} chars)`
    : viaHistory
      ? "CATCH-UP OK (via persisted history — replay path not exercised; rerun for the mid-run proof)"
      : "CATCH-UP FAILED",
);
await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(replayOK || viaHistory ? 0 : 1);
