#!/usr/bin/env bun
// Measure how fast a newly created question-form shows up in:
//   (a) global /api/form/request   (b) per-session /api/session/{sid}/form   (c) /form/{id}/state
import { Service } from "@opencode-ai/client/service";
const ep = await Service.ensure();
const h = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
const sid = "ses_fc47dc980ffefDBRhnfAtI52fK";

// raise a question via the scratch agent
await fetch(`${B}/api/session/${sid}/prompt`, { method: "POST", headers: h, body: JSON.stringify({ text:
  "Use your question tool ONCE: 'Lag probe - pick one', options p/q, then STOP." }) });

const t0 = Date.now();
let seenAt: Record<string, number> = {};
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const [g, s] = await Promise.all([
    fetch(`${B}/api/form/request`, { headers: h }).then(r => r.json()),
    fetch(`${B}/api/session/${sid}/form`, { headers: h }).then(r => r.json()),
  ]);
  const gid = g.data?.find((f: any) => f.metadata?.kind === "question")?.id;
  const sid2 = s.data?.[0]?.id;
  const key = `${gid ?? "-"}|${sid2 ?? "-"}`;
  if (!seenAt[key]) {
    seenAt[key] = Date.now() - t0;
    console.log(`t=${Date.now() - t0}ms global=${gid ?? "—"} perSession=${sid2 ?? "—"}`);
    if (gid && !seenAt["state:" + gid]) {
      const st = await fetch(`${B}/api/session/${sid}/form/${gid}/state`, { headers: h }).then(r => r.status);
      console.log(`t=${Date.now() - t0}ms state HTTP ${st}`);
    }
  }
  if (gid && sid2) { console.log(`t=${Date.now() - t0}ms BOTH visible — done`); break; }
}
