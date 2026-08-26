#!/usr/bin/env bun
// Record SSE events around form/question/permission lifecycle ops.
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const H = Service.headers(ep);
const B = ep.url;

// start SSE capture
const events: string[] = [];
const ac = new AbortController();
fetch(`${B}/api/event`, { headers: H, signal: ac.signal }).then(async (res) => {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (line.startsWith("data: ")) {
        try {
          const d = JSON.parse(line.slice(6));
          const t = d.type ?? "";
          if (/form|question|permission/i.test(t)) {
            events.push(JSON.stringify(d).slice(0, 400));
            console.log("EVT", JSON.stringify(d).slice(0, 400));
          }
        } catch {}
      }
    }
  }
}).catch(() => {});
await new Promise((r) => setTimeout(r, 500));

const h = { ...H, "content-type": "application/json" };
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: h as never, ...init });
  const t = await res.text();
  let body: unknown = t; try { body = JSON.parse(t); } catch {}
  return { status: res.status, body };
}

const created = await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model: null, location: null }) });
const sid = (created.body as { data: { id: string } }).data.id;
console.log("PROBE2 session:", sid);

// TWO-question popup: one single-choice, one free text
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text:
  "Use your question tool ONCE to ask me TWO questions together, then stop: (1) header 'Color', text 'Pick a color', options Red/Green, single select; (2) header 'Name', text 'What is your name?', NO options (free text). Then wait." }) });

let form: any = null;
for (let i = 0; i < 120 && !form; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const arr = ((await j(`/api/session/${sid}/form`)).body as { data?: any[] }).data ?? [];
  if (arr.length) form = arr[0];
}
if (!form) { console.log("no form"); ac.abort(); process.exit(1); }
console.log("FIELDS:", JSON.stringify(form.fields.map((f: any) => ({ key: f.key, type: f.type, title: f.title, custom: f.custom, opts: f.options?.length }))));

// wrong-shape trials against REAL pending form
const r1 = await j(`/api/session/${sid}/form/${form.id}/reply`, { method: "POST", body: JSON.stringify({ answer: { [form.fields[0].key]: ["Red"] } }) });
console.log("REPLY array-to-string-field:", r1.status, JSON.stringify(r1.body).slice(0, 200));
const st = await j(`/api/session/${sid}/form/${form.id}/state`);
console.log("STATE after bad reply:", st.status, JSON.stringify(st.body).slice(0, 200));

// correct mixed reply
const r2 = await j(`/api/session/${sid}/form/${form.id}/reply`, { method: "POST", body: JSON.stringify({ answer: { [form.fields[0].key]: "Red", [form.fields[1].key]: "Zoe" } }) });
console.log("REPLY strings:", r2.status, JSON.stringify(r2.body).slice(0, 200));
console.log("STATE:", JSON.stringify(await j(`/api/session/${sid}/form/${form.id}/state`)));

await new Promise((r) => setTimeout(r, 1500));
ac.abort();
console.log("---- all captured events ----");
for (const e of events) console.log(e);
