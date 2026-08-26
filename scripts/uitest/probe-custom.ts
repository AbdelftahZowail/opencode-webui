#!/usr/bin/env bun
// Multiselect + custom-answer reply shape ground truth.
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const h = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: h as never, ...init });
  const t = await res.text(); let b: unknown = t; try { b = JSON.parse(t); } catch {}
  return { status: res.status, body: b };
}
const created = await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model: null, location: null }) });
const sid = (created.body as { data: { id: string } }).data.id;
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text:
  "Use your question tool ONCE: 'Which fruits?' multiSelect enabled, options Apple/Banana, allow custom answers too. Then stop." }) });
let form: any = null;
for (let i = 0; i < 120 && !form; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const arr = ((await j(`/api/session/${sid}/form`)).body as { data?: any[] }).data ?? [];
  if (arr.length) form = arr[0];
}
if (!form) { console.log("no form"); process.exit(1); }
console.log("field:", form.fields[0].type, "custom:", form.fields[0].custom);
const k = form.fields[0].key;
const r = await j(`/api/session/${sid}/form/${form.id}/reply`, { method: "POST", body: JSON.stringify({ answer: { [k]: ["Apple", "Mango (custom)"] } }) });
console.log("REPLY mixed array:", r.status, JSON.stringify(r.body).slice(0, 200));
console.log("STATE:", JSON.stringify(await j(`/api/session/${sid}/form/${form.id}/state`)));
