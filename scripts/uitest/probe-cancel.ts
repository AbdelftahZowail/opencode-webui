#!/usr/bin/env bun
// Cancel-path ground truth: raise a question, cancel via REST, record events.
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const H = Service.headers(ep);
const B = ep.url;
const events: string[] = [];
const ac = new AbortController();
fetch(`${B}/api/event`, { headers: H, signal: ac.signal }).then(async (res) => {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith("data: ")) {
        try { const d = JSON.parse(line.slice(6));
          if (/form|question|permission/i.test(d.type ?? "")) { events.push(d.type); console.log("EVT", d.type, JSON.stringify(d.data).slice(0, 250)); }
        } catch {}
      }
    }
  }
}).catch(() => {});
await new Promise((r) => setTimeout(r, 500));
const h = { ...H, "content-type": "application/json" };
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: h as never, ...init });
  const t = await res.text(); let b: unknown = t; try { b = JSON.parse(t); } catch {}
  return { status: res.status, body: b };
}
const created = await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model: null, location: null }) });
const sid = (created.body as { data: { id: string } }).data.id;
console.log("PROBE3 session:", sid);
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text:
  "Use your question tool ONCE to ask 'Cancel me?' with options Yes/No, then stop and wait. Nothing else." }) });
let form: any = null;
for (let i = 0; i < 120 && !form; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const arr = ((await j(`/api/session/${sid}/form`)).body as { data?: any[] }).data ?? [];
  if (arr.length) form = arr[0];
}
if (!form) { console.log("no form"); ac.abort(); process.exit(1); }
console.log("pending form:", form.id);
const c = await j(`/api/session/${sid}/form/${form.id}/cancel`, { method: "POST" });
console.log("CANCEL:", c.status, JSON.stringify(c.body).slice(0, 200));
console.log("STATE:", JSON.stringify(await j(`/api/session/${sid}/form/${form.id}/state`)).slice(0, 200));
console.log("LISTING:", JSON.stringify((await j(`/api/session/${sid}/form`)).body));
await new Promise((r) => setTimeout(r, 1500));
ac.abort();
console.log("---- event types ----"); console.log(events.join("\n"));
