#!/usr/bin/env bun
// Fetch the live OpenAPI spec from the opencode service via Service discovery
// (same auth path as the proxy) into docs/reference/openapi.json.
//   bun run scripts/fetch-openapi.ts
import { Service } from "@opencode-ai/client/service";

const ep = await Service.ensure();
const res = await fetch(`${ep.url}/openapi.json`, { headers: Service.headers(ep) });
if (!res.ok) {
  console.error("HTTP", res.status);
  process.exit(1);
}
const spec = await res.json();
await Bun.write(new URL("../docs/reference/openapi.json", import.meta.url), JSON.stringify(spec, null, 2));
console.log("openapi paths:", Object.keys(spec.paths ?? {}).length);
