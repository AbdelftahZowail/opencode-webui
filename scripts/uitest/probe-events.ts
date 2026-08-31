#!/usr/bin/env bun
// Capture ALL distinct event types (with payload shape hints) during one short run.
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
const seen = new Map<string, number>();
let firstText = "";
const samples = new Map<string, string>();
const ac = new AbortController();
fetch(`${B}/api/event`, { headers: H as never, signal: ac.signal }).then(async (res) => {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith("data: ")) {
        try { const d = JSON.parse(line.slice(6));
          if (!d.type || d.type.startsWith("server.")) continue;
          seen.set(d.type, (seen.get(d.type) ?? 0) + 1);
          if (!samples.has(d.type)) samples.set(d.type, JSON.stringify(d.data).slice(0, 300));
          if (d.type === "session.text.delta" && !firstText) firstText = d.data?.delta ?? "";
        } catch {}
      }
    }
  }
}).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  return res.json();
}
const created = await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model: null, location: null }) });
const sid = created.data.id;
console.log("SESSION", sid);
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Count from 1 to 8 slowly, one number per line. Then say DONE." }) });
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const active = await j("/api/session/active");
  if (!active.data?.[sid]) break;
}
await new Promise((r) => setTimeout(r, 500));
ac.abort();
console.log("\n--- distinct event types during the run ---");
for (const [t, n] of [...seen].sort()) console.log(t.padEnd(38), String(n).padStart(4), "  e.g.", samples.get(t) ?? "");
await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(0);
