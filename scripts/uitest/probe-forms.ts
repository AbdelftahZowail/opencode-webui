#!/usr/bin/env bun
// Ground-truth probe: drive a real question through a scratch session and
// record EXACTLY what the engine exposes over REST for the webui.
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const h = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;

async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: h as never, ...init });
  const t = await res.text();
  let body: unknown = t;
  try { body = JSON.parse(t); } catch {}
  return { status: res.status, body };
}

// 1. scratch session
const created = await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model: null, location: null }) });
const sid = (created.body as { data: { id: string } }).data.id;
console.log("PROBE session:", sid);

// 2. ask the agent to raise a multi-select question and stop
const prompt =
  "Use your question tool to ask me exactly this, then stop and wait: question text 'Which fruits do you want?', header 'Fruits', options Apple/Banana/Cherry, multiSelect ENABLED (multiple answers allowed). Do not pick any option yourself. Do nothing else.";
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) });

// 3. wait for the form to appear
let form: any = null;
for (let i = 0; i < 120 && !form; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const lst = await j(`/api/session/${sid}/form`);
  const arr = (lst.body as { data?: any[] }).data ?? [];
  if (arr.length > 0) form = arr[0];
}
if (!form) { console.log("PROBE FAILED: no form appeared"); process.exit(1); }
console.log("FORM FULL:", JSON.stringify(form, null, 1));

// 4. what do the OTHER surfaces say while pending?
console.log("GLOBAL LISTING:", JSON.stringify(await j("/api/form/request")));
console.log("STATE:", JSON.stringify(await j(`/api/session/${sid}/form/${form.id}/state`)));
console.log("GET ONE:", JSON.stringify(await j(`/api/session/${sid}/form/${form.id}`)));

// 5. reply-shape trials — first accepted wins
const key = form.fields?.[0]?.key;
const opt = form.fields?.[0]?.options?.[0]?.value ?? form.fields?.[0]?.options?.[0]?.label;
const trials: Array<[string, unknown]> = [
  ["array", { [key]: [opt] }],
  ["string", { [key]: String(opt) }],
];
let replied = false;
for (const [name, answer] of trials) {
  const r = await j(`/api/session/${sid}/form/${form.id}/reply`, { method: "POST", body: JSON.stringify({ answer }) });
  console.log(`REPLY ${name}:`, r.status, JSON.stringify(r.body).slice(0, 300));
  if (r.status >= 200 && r.status < 300) { replied = true; break; }
}
console.log("REPLIED:", replied);
console.log("STATE AFTER REPLY:", JSON.stringify(await j(`/api/session/${sid}/form/${form.id}/state`)));
console.log("SESSION FORMS AFTER:", JSON.stringify(await j(`/api/session/${sid}/form`)));
console.log("GLOBAL AFTER:", JSON.stringify((await j("/api/form/request")).body));
