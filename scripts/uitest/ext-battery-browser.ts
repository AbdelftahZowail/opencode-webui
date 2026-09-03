#!/usr/bin/env bun
/**
 * Browser-stratum E2E battery (permanent).
 *
 *   bun run scripts/uitest/ext-battery-browser.ts
 *
 * Covers the BROWSER stratum against the REAL registry modules
 * (src/extensions/registry, src/extensions/hooks) plus live
 * manifest/bundle HTTP checks against an ISOLATED proxy:
 *
 *   WEBUI_EXTENSION_DIR=/tmp/opencode/bat-browser
 *   WEBUI_PROXY_PORT=4111
 *   WEBUI_SANDBOX=1  (loopback-only, passwordless)
 *
 * Own ports only — never touches :4097/:4099/:5173/:5175.
 * Test-only file: does NOT modify src/ or server/.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getContributions,
  getHooks,
  getRegisteredIds,
  getService,
  getServiceProviders,
  getTargetChain,
  hasTarget,
  register,
  registerTarget,
  renderTarget,
  unregisterIds,
} from "../../src/extensions/registry";
import { fireHooks } from "../../src/extensions/hooks";

const ROOT = join(import.meta.dir, "..", "..");
const BAT_DIR = "/tmp/opencode/bat-browser";
const PROXY_PORT = 4111;
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;
const SERVER_LOG = "/tmp/opencode/bat-browser-proxy.log";
const POLL_MS = 500;
const MANIFEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Row {
  label: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
  secs?: number;
}
const rows: Row[] = [];

function pass(label: string, detail: string, t0: number): void {
  rows.push({ label, status: "PASS", detail, secs: Date.now() - t0 });
}
function fail(label: string, detail: string, t0: number): void {
  rows.push({ label, status: "FAIL", detail, secs: Date.now() - t0 });
}

class Capture {
  out = "";
  err = "";
  push(chunk: Uint8Array, stream: "out" | "err"): void {
    const text = new TextDecoder().decode(chunk);
    if (stream === "out") this.out = (this.out + text).slice(-24_000);
    else this.err = (this.err + text).slice(-24_000);
  }
  get all(): string {
    return `${this.out}\n${this.err}`;
  }
  tail(max = 1_200): string {
    const t = this.all.trim();
    return t.length > max ? `…${t.slice(-max)}` : t;
  }
}

async function pump(
  stream: ReadableStream<Uint8Array> | null,
  cap: Capture,
  which: "out" | "err",
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) cap.push(value, which);
    }
  } catch {
    /* torn down with child */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}
function listDescendants(root: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([root]);
  let frontier = [root];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const pid of frontier) {
      const ps = Bun.spawnSync(["ps", "-o", "pid=", "--ppid", String(pid)]);
      if (ps.exitCode !== 0) continue;
      for (const line of ps.stdout.toString().split("\n")) {
        const v = Number(line.trim());
        if (Number.isInteger(v) && v > 0 && !seen.has(v)) {
          seen.add(v);
          next.push(v);
        }
      }
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}
async function killTree(pid: number, sub: { exited: Promise<number> } | null): Promise<void> {
  if (!pidAlive(pid)) return;
  const desc = listDescendants(pid);
  const leavesFirst = [...desc].reverse();
  for (const p of leavesFirst) signal(p, "SIGTERM");
  signal(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && (pidAlive(pid) || desc.some(pidAlive))) await sleep(150);
  for (const p of [...leavesFirst].reverse()) if (pidAlive(p)) signal(p, "SIGKILL");
  if (pidAlive(pid)) signal(pid, "SIGKILL");
  if (sub) await Promise.race([sub.exited.catch(() => undefined), sleep(2_000)]);
}
function listenersOn(port: number): number[] {
  try {
    const ss = Bun.spawnSync(["ss", "-ltnpH"]);
    if (ss.exitCode !== 0) return [];
    const pids: number[] = [];
    for (const line of ss.stdout.toString().split("\n")) {
      if (!line.includes(`:${port} `)) continue;
      const m = line.match(/pid=(\d+)/);
      const pid = m?.[1] ? Number(m[1]) : 0;
      if (pid > 0 && !pids.includes(pid)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}
async function waitHttp(url: string, timeoutMs: number, what: string): Promise<Response> {
  const t0 = Date.now();
  let last = "no response";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      last = `HTTP ${res.status}`;
      if (res.ok) return res;
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 80) : String(err);
    }
    await sleep(400);
  }
  throw new Error(`${what}: not ready after ${timeoutMs}ms (last: ${last})`);
}

// ---------------------------------------------------------------------------
// In-process registry battery (REAL registry + hooks modules)
// ---------------------------------------------------------------------------

function testWrapLeaf(): void {
  const t0 = Date.now();
  const label = "wrap message.timestamp delegates by default";
  const ids = ["bat-wrap-ts"];
  const target = "message.timestamp";
  unregisterIds(ids);
  try {
    registerTarget(target, (p) => `CORE:${String(p.iso ?? p.time ?? "")}`);
    registerTarget("message.tokens", () => "TOKENS-CORE");
    register({
      kind: "wrap",
      id: ids[0]!,
      target,
      render: (_props, next) => `WRAP[${String(next())}]`,
    });
    const out = renderTarget(target, { iso: "2026-01-01" }) as unknown;
    const chain = getTargetChain(target);
    const sibling = renderTarget("message.tokens", {}) as unknown;
    if (out !== "WRAP[CORE:2026-01-01]") {
      fail(label, `expected WRAP[CORE:2026-01-01], got ${JSON.stringify(out)}`, t0);
      return;
    }
    if (chain.wraps.length !== 1 || sibling !== "TOKENS-CORE") {
      fail(
        label,
        `chain wraps=${chain.wraps.length} sibling=${JSON.stringify(sibling)} — wrap leaked past its leaf`,
        t0,
      );
      return;
    }
    if (!hasTarget(target)) {
      fail(label, `hasTarget(${target}) false after registration`, t0);
      return;
    }
    pass(label, `renderTarget → ${JSON.stringify(out)}; sibling untouched (${JSON.stringify(sibling)})`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    unregisterIds(ids);
  }
}

function testReplaceFallthrough(): void {
  const t0 = Date.now();
  const label = "replace ownership + null fall-through";
  const ids = ["bat-rep-banner", "bat-rep-owned"];
  const target = "bat.tool.replace";
  unregisterIds(ids);
  try {
    registerTarget(target, (p) => `CORE:${String((p as { summary?: string }).summary ?? "")}`);
    register({
      kind: "replace",
      id: ids[0]!,
      target,
      priority: 10,
      render: (props, _core) =>
        (props as { summary?: string }).summary === "banner" ? "BANNER" : null,
    });
    register({
      kind: "replace",
      id: ids[1]!,
      target,
      priority: 20,
      render: (props) => `OWNED:${String((props as { summary?: string }).summary ?? "")}`,
    });
    const banner = renderTarget(target, { summary: "banner" }) as unknown;
    const other = renderTarget(target, { summary: "other" }) as unknown;
    if (banner !== "BANNER") {
      fail(label, `banner case: expected BANNER, got ${JSON.stringify(banner)}`, t0);
      return;
    }
    if (other !== "OWNED:other") {
      fail(label, `fall-through case: expected OWNED:other, got ${JSON.stringify(other)}`, t0);
      return;
    }
    // First replace returns null → falls to second; removing the owner
    // must restore the core default (no frozen residue).
    unregisterIds([ids[1]!]);
    const afterUnreg = renderTarget(target, { summary: "other" }) as unknown;
    if (afterUnreg !== "CORE:other") {
      fail(label, `after unregister expected CORE:other, got ${JSON.stringify(afterUnreg)}`, t0);
      return;
    }
    pass(label, `banner→BANNER, other→OWNED:other, unowned→CORE:other`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    unregisterIds(ids);
  }
}

function testContributeAll(): void {
  const collections = [
    "palette",
    "slash",
    "pages",
    "settings",
    "contextMenu.message",
    "contextMenu.session",
    "contextMenu.file",
  ] as const;
  const items: Record<string, unknown> = {
    palette: { title: "Bat palette", run: () => {} },
    slash: { name: "bat-slash", description: "battery", run: () => {} },
    pages: { title: "Bat page", render: () => null },
    settings: { title: "Bat settings", render: () => null },
    "contextMenu.message": { label: "Bat msg", run: () => {} },
    "contextMenu.session": { label: "Bat ses", run: () => {} },
    "contextMenu.file": { label: "Bat file", run: () => {} },
  };
  for (const collection of collections) {
    const t0 = Date.now();
    const label = `contribute ${collection}`;
    const id = `bat-con-${collection.replace(/\./g, "-")}`;
    unregisterIds([id, `${id}-lo`, `${id}-hi`]);
    try {
      register({ kind: "contribute", id, collection, item: items[collection], order: 10 });
      const got = getContributions(collection);
      const hit = got.find((c) => c.id === id);
      if (!hit) {
        fail(label, `id ${id} missing from getContributions(${collection})`, t0);
        continue;
      }
      // Order check on palette only (keeps the battery fast): lower first.
      if (collection === "palette") {
        register({ kind: "contribute", id: `${id}-lo`, collection, item: { title: "lo", run: () => {} }, order: 1 });
        register({ kind: "contribute", id: `${id}-hi`, collection, item: { title: "hi", run: () => {} }, order: 200 });
        const ordered = getContributions(collection)
          .filter((c) => c.id.startsWith(id))
          .map((c) => c.id);
        const loIdx = ordered.indexOf(`${id}-lo`);
        const meIdx = ordered.indexOf(id);
        const hiIdx = ordered.indexOf(`${id}-hi`);
        if (!(loIdx !== -1 && meIdx !== -1 && hiIdx !== -1 && loIdx < meIdx && meIdx < hiIdx)) {
          fail(label, `order broken: ${ordered.join(",")}`, t0);
          continue;
        }
      }
      pass(label, `item visible via getContributions (${JSON.stringify(Object.keys((hit.item as object) ?? {}))})`, t0);
    } catch (err) {
      fail(label, err instanceof Error ? err.message : String(err), t0);
    } finally {
      unregisterIds([id, `${id}-lo`, `${id}-hi`]);
    }
  }
}

async function testHooks(): Promise<void> {
  // api.pre rewrite
  {
    const t0 = Date.now();
    const label = "hook api.pre rewrite";
    const ids = ["bat-hook-apipre"];
    unregisterIds(ids);
    try {
      register({
        kind: "hook",
        id: ids[0]!,
        event: "api.pre",
        handler: (ctx) => {
          (ctx.args as unknown[])[0] = "REWRITTEN";
        },
      });
      const ctx: Record<string, unknown> = { name: "session.prompt", args: ["original"] };
      await fireHooks("api.pre", ctx);
      if ((ctx.args as unknown[])[0] !== "REWRITTEN") {
        fail(label, `args not rewritten: ${JSON.stringify(ctx.args)}`, t0);
      } else {
        pass(label, `ctx.args[0] original→REWRITTEN`, t0);
      }
    } catch (err) {
      fail(label, err instanceof Error ? err.message : String(err), t0);
    } finally {
      unregisterIds(ids);
    }
  }
  // session.prompt mutation
  {
    const t0 = Date.now();
    const label = "hook session.prompt mutation";
    const ids = ["bat-hook-prompt"];
    unregisterIds(ids);
    try {
      register({
        kind: "hook",
        id: ids[0]!,
        event: "session.prompt",
        handler: (ctx) => {
          ctx.text = `[via webui] ${String(ctx.text ?? "")}`;
        },
      });
      const ctx: Record<string, unknown> = { text: "hello", sessionID: "s1" };
      await fireHooks("session.prompt", ctx);
      if (ctx.text !== "[via webui] hello") {
        fail(label, `text not mutated: ${JSON.stringify(ctx.text)}`, t0);
      } else {
        pass(label, `ctx.text → ${JSON.stringify(ctx.text)}`, t0);
      }
    } catch (err) {
      fail(label, err instanceof Error ? err.message : String(err), t0);
    } finally {
      unregisterIds(ids);
    }
  }
  // crash isolation
  {
    const t0 = Date.now();
    const label = "hook crash isolation";
    const ids = ["bat-hook-crash", "bat-hook-good"];
    unregisterIds(ids);
    try {
      let goodRan = false;
      register({
        kind: "hook",
        id: ids[0]!,
        event: "bat.crash.probe",
        handler: () => {
          throw new Error("boom (battery crash probe)");
        },
      });
      register({
        kind: "hook",
        id: ids[1]!,
        event: "bat.crash.probe",
        handler: (ctx) => {
          goodRan = true;
          ctx.touched = true;
        },
      });
      const ctx: Record<string, unknown> = {};
      await fireHooks("bat.crash.probe", ctx); // must not throw
      if (!goodRan || ctx.touched !== true) {
        fail(label, `good handler skipped after crash (ran=${goodRan})`, t0);
      } else {
        pass(label, `throwing handler isolated; next handler still ran`, t0);
      }
    } catch (err) {
      fail(label, `fireHooks threw (isolation broken): ${err instanceof Error ? err.message : String(err)}`, t0);
    } finally {
      unregisterIds(ids);
    }
  }
}

function testService(): void {
  const t0 = Date.now();
  const label = "service provide/override format.timestamp";
  const ids = ["bat-svc-low", "bat-svc-high"];
  unregisterIds(ids);
  try {
    const low = () => "low";
    const high = () => "high";
    register({ kind: "service", id: ids[0]!, service: "format.timestamp", value: low, precedence: 0 });
    register({ kind: "service", id: ids[1]!, service: "format.timestamp", value: high, precedence: 10 });
    const winner = getService<() => string>("format.timestamp");
    if (!winner || winner() !== "high") {
      fail(label, `highest precedence did not win (got ${winner ? winner() : "undefined"})`, t0);
      return;
    }
    const providers = getServiceProviders("format.timestamp").filter((p) => ids.includes(p.id));
    if (providers.length !== 2 || providers[0]!.id !== ids[1] || providers[1]!.id !== ids[0]) {
      fail(label, `provider order wrong: ${providers.map((p) => `${p.id}:${p.precedence}`).join(",")}`, t0);
      return;
    }
    pass(label, `precedence 10 wins over 0; providers sorted highest-first`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    unregisterIds(ids);
  }
}

function testSameIdSwap(): void {
  const t0 = Date.now();
  const label = "same-id swap";
  const id = "bat-swap";
  const target = "bat.target.swap";
  unregisterIds([id]);
  try {
    registerTarget(target, () => "CORE");
    register({ kind: "wrap", id, target, render: (_p, _n) => "V1" });
    const v1 = renderTarget(target, {}) as unknown;
    register({ kind: "wrap", id, target, render: (_p, _n) => "V2" });
    const v2 = renderTarget(target, {}) as unknown;
    const chain = getTargetChain(target);
    const idCount = getRegisteredIds().filter((x) => x === id).length;
    if (v1 !== "V1" || v2 !== "V2") {
      fail(label, `swap did not take: v1=${JSON.stringify(v1)} v2=${JSON.stringify(v2)}`, t0);
      return;
    }
    if (chain.wraps.length !== 1 || idCount !== 1) {
      fail(label, `duplicate entries after swap (wraps=${chain.wraps.length} ids=${idCount})`, t0);
      return;
    }
    pass(label, `re-register same id swaps in place (V1→V2, single entry)`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    unregisterIds([id]);
  }
}

function testUnregisterRestore(): void {
  const t0 = Date.now();
  const label = "unregisterIds restore";
  const ids = ["bat-gone-wrap", "bat-gone-con", "bat-gone-svc", "bat-gone-hook"];
  const target = "bat.target.gone";
  unregisterIds(ids);
  try {
    registerTarget(target, () => "CORE-GONE");
    register({ kind: "wrap", id: ids[0]!, target, render: (_p, _n) => "WRAPPED" });
    register({ kind: "contribute", id: ids[1]!, collection: "palette", item: { title: "gone", run: () => {} } });
    register({ kind: "service", id: ids[2]!, service: "bat.svc.gone", value: 1, precedence: 5 });
    register({ kind: "hook", id: ids[3]!, event: "bat.gone.evt", handler: () => {} });
    const before =
      (renderTarget(target, {}) as unknown) === "WRAPPED" &&
      getContributions("palette").some((c) => c.id === ids[1]) &&
      getService("bat.svc.gone") === 1 &&
      getHooks("bat.gone.evt").length === 1;
    if (!before) {
      fail(label, `setup incomplete before unregister`, t0);
      return;
    }
    unregisterIds(ids);
    // No-op calls must be safe.
    unregisterIds([]);
    unregisterIds(["bat-never-existed"]);
    const rendered = renderTarget(target, {}) as unknown;
    const restored =
      rendered === "CORE-GONE" &&
      !getContributions("palette").some((c) => c.id === ids[1]) &&
      getService("bat.svc.gone") === undefined &&
      getHooks("bat.gone.evt").length === 0 &&
      hasTarget(target); // core default survives (core is never unregistered)
    if (!restored) {
      fail(label, `after unregister: render=${JSON.stringify(rendered)} (want CORE-GONE)`, t0);
      return;
    }
    pass(label, `all four kinds pruned; core default intact`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    unregisterIds(ids);
  }
}

// ---------------------------------------------------------------------------
// Live proxy battery (manifest + bundle HTTP)
// ---------------------------------------------------------------------------

const cap = new Capture();
let proxyProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;

type ManifestEntry = {
  id?: string;
  url?: string;
  domUrl?: string;
  source?: string;
  origin?: string;
  disabled?: boolean;
};

async function fetchManifest(): Promise<{ data: ManifestEntry[]; version: number }> {
  const res = await fetch(`${PROXY_BASE}/api/webui/extensions`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const body = (await res.json()) as { data?: ManifestEntry[]; version?: number };
  return { data: Array.isArray(body.data) ? body.data : [], version: body.version ?? -1 };
}

async function waitForManifest(
  pred: (data: ManifestEntry[]) => boolean,
  what: string,
  timeoutMs = MANIFEST_TIMEOUT_MS,
): Promise<ManifestEntry[]> {
  const t0 = Date.now();
  let last: ManifestEntry[] = [];
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = (await fetchManifest()).data;
      if (pred(last)) return last;
    } catch {
      /* proxy warming up */
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${what}: condition unmet after ${timeoutMs}ms (ids: ${last.map((e) => e.id).join(",") || "none"})`);
}

function writeExt(
  dirName: string,
  opts: { id: string; disabled?: boolean; marker: string; extraIndex?: string },
): string {
  const dir = join(BAT_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        id: opts.id,
        name: opts.id,
        version: "1.0.0",
        description: "browser battery fixture",
        ...(opts.disabled ? { disabled: true } : {}),
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "index.tsx"), `// ${opts.marker}\nexport const marker = "${opts.marker}";\n${opts.extraIndex ?? ""}`);
  return dir;
}

async function startProxy(): Promise<void> {
  mkdirSync(BAT_DIR, { recursive: true });
  // Own port only: sweep stale listeners on 4111 (ours by definition).
  for (const pid of listenersOn(PROXY_PORT)) {
    signal(pid, "SIGTERM");
    await sleep(300);
    if (pidAlive(pid)) signal(pid, "SIGKILL");
  }
  proxyProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WEBUI_EXTENSION_DIR: BAT_DIR,
      WEBUI_PROXY_PORT: String(PROXY_PORT),
      WEBUI_SANDBOX: "1",
      WEBUI_HOST: "127.0.0.1",
    },
  });
  void pump(proxyProc.stdout, cap, "out");
  void pump(proxyProc.stderr, cap, "err");
  await waitHttp(`${PROXY_BASE}/api/webui/extensions`, 30_000, "isolated proxy (4111)");
}

async function testManifestShape(): Promise<void> {
  const t0 = Date.now();
  const label = "live manifest route shape";
  try {
    const res = await fetch(`${PROXY_BASE}/api/webui/extensions`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: unknown; version?: unknown };
    if (res.status !== 200 || !Array.isArray(body.data) || typeof body.version !== "number") {
      fail(label, `HTTP ${res.status}, data array=${Array.isArray(body.data)}, version=${String(body.version)}`, t0);
      return;
    }
    pass(label, `GET /api/webui/extensions → 200, ${(body.data as unknown[]).length} entr(ies), version ${String(body.version)}`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  }
}

async function testUnknownBundle404(): Promise<void> {
  const t0 = Date.now();
  const label = "live unknown bundle id → 404";
  try {
    const res = await fetch(`${PROXY_BASE}/api/webui/extensions/zz-not-a-plugin/bundle.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 404) fail(label, `HTTP ${res.status} (expected 404)`, t0);
    else pass(label, `HTTP 404 for unknown id`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  }
}

async function testDisabledPause(): Promise<void> {
  // Paused: disabled:true → manifest entry WITHOUT url, bundle 404.
  {
    const t0 = Date.now();
    const label = "live manifest disabled:true pause";
    try {
      writeExt("bat-paused", { id: "bat-paused", disabled: true, marker: "BAT_PAUSED_MARKER" });
      const data = await waitForManifest(
        (d) => d.some((e) => e.id === "bat-paused" && e.disabled === true && !e.url),
        "paused entry",
      );
      const entry = data.find((e) => e.id === "bat-paused")!;
      const bundle = await fetch(`${PROXY_BASE}/api/webui/extensions/bat-paused/bundle.js`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (bundle.status !== 404) {
        fail(label, `paused bundle HTTP ${bundle.status} (expected 404)`, t0);
        return;
      }
      pass(label, `id bat-paused disabled:true, no url (source ${entry.source ?? "?"}) → bundle 404`, t0);
    } catch (err) {
      fail(label, err instanceof Error ? err.message : String(err), t0);
    }
  }
  // Re-enable: flip the flag → url appears, bundle serves.
  {
    const t0 = Date.now();
    const label = "live disabled flip re-enables";
    try {
      writeExt("bat-paused", { id: "bat-paused", marker: "BAT_PAUSED_MARKER" });
      const data = await waitForManifest(
        (d) => d.some((e) => e.id === "bat-paused" && !e.disabled && typeof e.url === "string"),
        "re-enabled entry",
      );
      const entry = data.find((e) => e.id === "bat-paused")!;
      const bundle = await fetch(
        `${PROXY_BASE}/api/webui/extensions/bat-paused/bundle.js`,
        { signal: AbortSignal.timeout(5_000) },
      );
      const js = await bundle.text();
      const ok =
        bundle.status === 200 &&
        (bundle.headers.get("content-type") ?? "").includes("javascript") &&
        js.includes("BAT_PAUSED_MARKER");
      if (!ok) {
        fail(label, `bundle broken: HTTP ${bundle.status}, ${js.length}b`, t0);
        return;
      }
      pass(label, `url ${entry.url} → bundle ${js.length}b contains marker`, t0);
    } catch (err) {
      fail(label, err instanceof Error ? err.message : String(err), t0);
    } finally {
      rmSync(join(BAT_DIR, "bat-paused"), { recursive: true, force: true });
    }
  }
}

async function testDeleteUninstall(): Promise<void> {
  const t0 = Date.now();
  const label = "live delete uninstall";
  try {
    writeExt("bat-ephem", { id: "bat-ephem", marker: "BAT_EPHEM_MARKER" });
    await waitForManifest(
      (d) => d.some((e) => e.id === "bat-ephem" && typeof e.url === "string"),
      "ephem installed",
    );
    const bundle = await fetch(`${PROXY_BASE}/api/webui/extensions/bat-ephem/bundle.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    const js = await bundle.text();
    if (bundle.status !== 200 || !js.includes("BAT_EPHEM_MARKER")) {
      fail(label, `pre-delete bundle broken: HTTP ${bundle.status}`, t0);
      return;
    }
    rmSync(join(BAT_DIR, "bat-ephem"), { recursive: true, force: true });
    await waitForManifest((d) => !d.some((e) => e.id === "bat-ephem"), "ephem uninstalled");
    const gone = await fetch(`${PROXY_BASE}/api/webui/extensions/bat-ephem/bundle.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (gone.status !== 404) {
      fail(label, `post-delete bundle HTTP ${gone.status} (expected 404)`, t0);
      return;
    }
    pass(label, `folder deleted → id vanishes → bundle 404`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
    rmSync(join(BAT_DIR, "bat-ephem"), { recursive: true, force: true });
  }
}

async function testShadowPrecedence(): Promise<void> {
  const t0 = Date.now();
  const label = "live user-shadows-shipped precedence";
  const shadowDir = join(BAT_DIR, "report");
  try {
    // Baseline: shipped report exists with NO bundle url (glob-owned).
    const base = await fetchManifest();
    const shipped = base.data.find((e) => e.id === "report");
    if (!shipped) {
      fail(label, `baseline missing: no shipped "report" in manifest (ids: ${base.data.map((e) => e.id).join(",")})`, t0);
      return;
    }
    // Shadow it from the isolated user dir.
    writeExt("report", { id: "report", marker: "BAT_SHADOW_REPORT_V1" });
    const shadowed = await waitForManifest(
      (d) => d.filter((e) => e.id === "report").length === 1 && d.some((e) => e.id === "report" && e.origin === "user"),
      "shadow wins",
    );
    const entry = shadowed.find((e) => e.id === "report")!;
    if (typeof entry.url !== "string") {
      fail(label, `shadow has no url (manifest: ${JSON.stringify(entry).slice(0, 200)})`, t0);
      return;
    }
    const bundle = await fetch(`${PROXY_BASE}/api/webui/extensions/report/bundle.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    const js = await bundle.text();
    if (bundle.status !== 200 || !js.includes("BAT_SHADOW_REPORT_V1")) {
      fail(label, `shadow bundle broken: HTTP ${bundle.status}, ${js.length}b`, t0);
      return;
    }
    // Remove the shadow → shipped copy owns the id again.
    rmSync(shadowDir, { recursive: true, force: true });
    const reverted = await waitForManifest(
      (d) => d.filter((e) => e.id === "report").length === 1 && d.some((e) => e.id === "report" && e.origin === "shipped" && !e.url),
      "shadow reverted",
    );
    const back = reverted.find((e) => e.id === "report")!;
    pass(
      label,
      `user shadow (origin ${entry.origin}) served marker; delete → shipped back (origin ${back.origin}, no url)`,
      t0,
    );
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
    rmSync(shadowDir, { recursive: true, force: true });
  }
}

async function testLiveEditSwap(): Promise<void> {
  const t0 = Date.now();
  const label = "live same-id edit swap (bundle ?v= rebuild)";
  const dir = "bat-swap-live";
  try {
    writeExt(dir, { id: "bat-swap-live", marker: "BAT_SWAP_V1" });
    await waitForManifest(
      (d) => d.some((e) => e.id === "bat-swap-live" && typeof e.url === "string"),
      "swap-live installed",
    );
    const b1 = await fetch(`${PROXY_BASE}/api/webui/extensions/bat-swap-live/bundle.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    const js1 = await b1.text();
    if (b1.status !== 200 || !js1.includes("BAT_SWAP_V1")) {
      fail(label, `v1 bundle broken: HTTP ${b1.status}`, t0);
      return;
    }
    await sleep(50); // ensure mtime moves so the mtime-keyed bundle rebuilds
    writeExt(dir, { id: "bat-swap-live", marker: "BAT_SWAP_V2" });
    const t1 = Date.now();
    let swapped = false;
    while (Date.now() - t1 < MANIFEST_TIMEOUT_MS) {
      const r = await fetch(`${PROXY_BASE}/api/webui/extensions/bat-swap-live/bundle.js`, {
        signal: AbortSignal.timeout(5_000),
      });
      const js = await r.text();
      if (r.status === 200 && js.includes("BAT_SWAP_V2")) {
        swapped = true;
        break;
      }
      await sleep(POLL_MS);
    }
    if (!swapped) fail(label, `bundle never rebuilt to V2 within ${MANIFEST_TIMEOUT_MS}ms`, t0);
    else pass(label, `edit v1→v2 rebuilt under the same id (no reinstall)`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    rmSync(join(BAT_DIR, dir), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  if (proxyProc) await killTree(proxyProc.pid, proxyProc).catch(() => undefined);
  for (const pid of listenersOn(PROXY_PORT)) {
    signal(pid, "SIGTERM");
    await sleep(300);
    if (pidAlive(pid)) signal(pid, "SIGKILL");
  }
  for (const dir of ["bat-paused", "bat-ephem", "report", "bat-swap-live"]) {
    try {
      rmSync(join(BAT_DIR, dir), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    if (existsSync(SERVER_LOG)) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(SERVER_LOG, `\n--- battery ${new Date().toISOString()} ---\n${cap.all.slice(-8_000)}\n`);
    }
  } catch {
    /* log sink best effort */
  }
}

function report(): void {
  const width = Math.max(...rows.map((r) => r.label.length), 30);
  console.log("\n=== browser-stratum battery ===");
  for (const r of rows) {
    const secs = r.secs !== undefined ? ` (${(r.secs / 1000).toFixed(1)}s)` : "";
    console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}${secs}`);
    if (r.detail) {
      for (const line of r.detail.split("\n")) console.log(`     ${line}`);
    }
  }
  const passN = rows.filter((r) => r.status === "PASS").length;
  const failN = rows.filter((r) => r.status === "FAIL").length;
  const skipN = rows.filter((r) => r.status === "SKIP").length;
  console.log(`\nRESULT: ${passN} pass · ${failN} fail · ${skipN} skip → exit ${failN > 0 ? 1 : 0}`);
}

async function main(): Promise<void> {
  mkdirSync("/tmp/opencode", { recursive: true });
  // In-process registry battery (no I/O, real modules).
  testWrapLeaf();
  testReplaceFallthrough();
  testContributeAll();
  await testHooks();
  testService();
  testSameIdSwap();
  testUnregisterRestore();

  // Live proxy battery (isolated 4111/sandbox).
  const t0 = Date.now();
  try {
    await startProxy();
    rows.push({ label: "SETUP isolated proxy 4111 (sandbox)", status: "PASS", secs: Date.now() - t0 });
  } catch (err) {
    rows.push({
      label: "SETUP isolated proxy 4111 (sandbox)",
      status: "FAIL",
      detail: `${err instanceof Error ? err.message : String(err)}\n${cap.tail(800)}`,
      secs: Date.now() - t0,
    });
    for (const label of [
      "live manifest route shape",
      "live unknown bundle id → 404",
      "live manifest disabled:true pause",
      "live disabled flip re-enables",
      "live delete uninstall",
      "live user-shadows-shipped precedence",
      "live same-id edit swap (bundle ?v= rebuild)",
    ]) {
      rows.push({ label, status: "SKIP", detail: "proxy never came up" });
    }
    return;
  }
  await testManifestShape();
  await testUnknownBundle404();
  await testDisabledPause();
  await testDeleteUninstall();
  await testShadowPrecedence();
  await testLiveEditSwap();
}

let code = 0;
try {
  await main();
} catch (err) {
  rows.push({
    label: "SETUP (fatal)",
    status: "FAIL",
    detail: (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 2_000) + (cap.all.trim() ? `\nproxy tail:\n${cap.tail(1_500)}` : ""),
  });
  code = 1;
} finally {
  await cleanup();
  report();
}
await sleep(50);
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : code);
