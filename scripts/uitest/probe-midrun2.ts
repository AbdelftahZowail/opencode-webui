#!/usr/bin/env bun
// Does REST serve GROWING content during a run — via the listing AND via the
// per-message endpoint? Sample fast, print part-length evolution.
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  return res.json();
}
const created = await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model: null, location: null }) });
const sid = created.data.id;
console.log("SESSION", sid);
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Think step by step about why the sky is blue for at least 8 sentences, then write a 5-line poem about rain." }) });
const t0 = Date.now();
let asstID = "";
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 700));
  const active = await j("/api/session/active");
  if (!active.data?.[sid]) { console.log(`t+${((Date.now()-t0)/1000).toFixed(1)}s RUN ENDED`); break; }
  const msgs = (await j(`/api/session/${sid}/message?limit=3`)).data ?? [];
  const a = [...msgs].reverse().find((m: any) => m.type === "assistant");
  if (!a) { console.log(`t+${((Date.now()-t0)/1000).toFixed(1)}s: no assistant row`); continue; }
  if (!asstID) asstID = a.id;
  const list = (a.content ?? []).map((p: any) => `${p.type}:${(p.text ?? "").length}${p.state ? "(" + p.state.status + ")" : ""}`).join(" ");
  // per-message endpoint (freshness comparison)
  let single = "n/a";
  if (asstID) {
    const one = await j(`/api/session/${sid}/message/${asstID}`);
    const m = one.data ?? one;
    single = (m?.content ?? []).map((p: any) => `${p.type}:${(p.text ?? "").length}`).join(" ") || "empty";
  }
  console.log(`t+${((Date.now()-t0)/1000).toFixed(1)}s LIST[${list}] SINGLE[${single}]`);
}
await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(0);
