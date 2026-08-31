#!/usr/bin/env bun
/**
 * End-to-end catch-up proof: start a run, attach a FRESH store client 6s
 * late (no SSE events seen), and verify selectSession's replay pull
 * reconstructs the live projection from the proxy recorder.
 */
import { Service } from "@opencode-ai/client/service";

// 1) start the run via the service directly (as the engine sees it)
const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  return res.json();
}
const created = await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model: null, location: null }) });
const sid = created.data.id;
console.log("SESSION:", sid);
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Think about rain for at least 6 sentences, then write a 4-line poem about rain." }) });

// 2) attach LATE: let the run get going first
await new Promise((r) => setTimeout(r, 6000));
const active = await j("/api/session/active");
if (!active.data?.[sid]) console.log("WARN: run already ended before attach");

// 3) fresh store client (no SSE in this process) — redirect /api to the proxy
const origFetch = globalThis.fetch;
(globalThis as { fetch: typeof fetch }).fetch = ((url: string | URL, init?: RequestInit) => {
  const u = typeof url === "string" ? url : url.toString();
  return origFetch(u.startsWith("/") ? `http://127.0.0.1:4097${u}` : u, init);
}) as typeof fetch;
const { selectSession, getState } = await import("../../src/store");
await selectSession(sid);
await new Promise((r) => setTimeout(r, 1200)); // replay pull + reducer

const st = getState();
const live = st.live.filter((a) => a.sessionID === sid);
const reasoningLen = live.reduce((n, a) => n + a.reasoning.length, 0);
const textLen = live.reduce((n, a) => n + a.text.length, 0);
const toolCount = live.reduce((n, a) => n + a.tools.size, 0);
console.log("live entries:", live.length, "reasoning chars:", reasoningLen, "text chars:", textLen, "tools:", toolCount, "running:", !!st.running[sid]);
const ok = live.length > 0 && reasoningLen + textLen > 200;
console.log(ok ? "CATCH-UP OK — late join reconstructed the stream" : "CATCH-UP FAILED");
await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(ok ? 0 : 1);
