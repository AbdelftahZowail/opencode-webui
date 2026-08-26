#!/usr/bin/env bun
// Permission round-trip ground truth.
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
          if (/permission|form|question/i.test(d.type ?? "")) { events.push(d.type); console.log("EVT", d.type, JSON.stringify(d.data).slice(0, 300)); }
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
console.log("PROBE4 session:", sid);
const mk = await j(`/api/session/${sid}/permission`, { method: "POST", body: JSON.stringify({ action: "read", resources: ["/etc/hostname"] }) });
console.log("CREATE:", mk.status, JSON.stringify(mk.body).slice(0, 400));
await new Promise((r) => setTimeout(r, 800));
console.log("GLOBAL LISTING:", JSON.stringify((await j("/api/permission/request")).body).slice(0, 500));
const per = (mk.body as { data?: { id?: string } }).data?.id;
if (per) {
  const rep = await j(`/api/session/${sid}/permission/${per}/reply`, { method: "POST", body: JSON.stringify({ reply: "once", message: null }) });
  console.log("REPLY once:", rep.status, JSON.stringify(rep.body).slice(0, 200));
}
await new Promise((r) => setTimeout(r, 1000));
console.log("LISTING AFTER REPLY:", JSON.stringify((await j("/api/permission/request")).body).slice(0, 300));
ac.abort();
console.log("---- events ----"); console.log(events.join("\n"));
