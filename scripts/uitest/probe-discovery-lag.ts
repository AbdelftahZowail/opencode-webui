#!/usr/bin/env bun
// Watch ALL discovery paths for the next question raised on ses_fc4f49174.
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const h = Service.headers(ep);
const B = ep.url;
const sid = "ses_fc4f49174ffeqWuZDYW7gVpkte";
const t0 = Date.now();
const seen = new Set<string>();
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const t = Date.now() - t0;
  try {
    const g = await fetch(`${B}/api/form/request`, { headers: h }).then(r => r.json());
    const ids: string[] = (g.data ?? []).filter((f: any) => f.sessionID === sid).map((f: any) => f.id);
    for (const id of ids) if (!seen.has("g:" + id)) { seen.add("g:" + id); console.log(`t=${t}ms GLOBAL lists ${id}`); }
    for (const id of ids.slice(0, 2)) {
      const key = "s:" + id;
      if (!seen.has(key)) {
        const res = await fetch(`${B}/api/session/${sid}/form/${id}/state`, { headers: h });
        seen.add(key);
        console.log(`t=${t}ms STATE ${id} HTTP ${res.status} ${(await res.text()).slice(0, 80)}`);
      }
    }
    if (seen.size >= 2 && ids.length > 0) break;
  } catch (e) { console.log(`t=${t}ms poll error`, String(e).slice(0, 80)); }
}
console.log("done", [...seen].join(" "));
