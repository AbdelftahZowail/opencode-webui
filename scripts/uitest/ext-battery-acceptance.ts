#!/usr/bin/env bun
/**
 * Extension loader + acceptance battery (spec §6 hot paths + §13 checks).
 *
 *   bun run scripts/uitest/ext-battery-acceptance.ts
 *
 * Spawns an ISOLATED proxy (`server/index.ts` on 4114, WEBUI_SANDBOX=1,
 * WEBUI_EXTENSION_DIR=/tmp/opencode/bat-accept — never the developer's own
 * instance or extension dirs) and walks the loader contract end to end:
 *
 *   L1 hot ADD      drop a folder in the live dir → manifest lists it, bundle
 *                   serves, proxy pid unchanged (no rebuild/refresh/restart).
 *   L2 hot EDIT     rewrite index.tsx → SSE manifest push with a bumped ?v=,
 *                   asserted sub-second from write to push.
 *   L3 DISABLED     manifest `disabled: true` → paused (no url, bundle 404).
 *   L4 RE-ENABLE    flip back → serving again.
 *   L5 DELETE       rm the folder → uninstalled (gone from manifest, 404).
 *   P1 PRECEDENCE   user > project > shipped (static scan order + live shadow
 *                   of the shipped `report` extension from the scratch dir).
 *   P2 SHIPPED-ONCE shipped browser entries carry no `url` (the in-repo Vite
 *                   glob owns them) → the runtime can never double-import or
 *                   fire `extension.loaded` twice.
 *   G1 ONLY-GATE    manifest presence/`disabled` is the only gate: no
 *                   config.ts list, no per-browser localStorage gating.
 *   T1 WRAP         §5.4 end-to-end at the registry: wrap tweak + maintainer
 *                   sibling redesign + new badge all visible together.
 *   T2 REPLACE      §5.4 ownership: replace owns its unit (core redesign of
 *                   that unit does NOT show) while siblings still update.
 *   S1 SHARED-REACT stateful (useState) extension bundles keep `react`
 *                   external — no inlined second copy (the invalid-hook-call
 *                   regression guard); vendor shims serve the app's instance.
 *   M1 GEN:SKILL    `bun run gen:skill` exits 0.
 *   M2 TYPECHECK    `bun run typecheck` exits 0.
 *   M3 GREP-CLEAN   no `<Slot`, no legacy kinds/getters, no
 *                   ui-extensions/config refs outside intentional history.
 *
 * Test-only file: reads src/server/webui-extensions, never modifies them.
 * Cleanup is unconditional (finally): scratch folders removed, proxy killed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  register,
  registerTarget,
  renderTarget,
  unregisterIds,
} from "../../src/extensions/registry";

const ROOT = join(import.meta.dir, "..", "..");
const SELF = join(import.meta.dir, "ext-battery-acceptance.ts");
const BAT_DIR = "/tmp/opencode/bat-accept";
const PROXY_PORT = 4114;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const EXT_ID = "bat-time";
const EXT_DIR = join(BAT_DIR, EXT_ID);
const STATEFUL_ID = "bat-stateful";
const STATEFUL_DIR = join(BAT_DIR, STATEFUL_ID);
const SHADOW_ID = "report"; // shipped id we shadow for P1/P2
const SHADOW_DIR = join(BAT_DIR, SHADOW_ID);
const POLL_MS = 250;

// ---------------------------------------------------------------------------
// Rows + helpers
// ---------------------------------------------------------------------------

interface Row {
  label: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
  secs?: number;
}
const rows: Row[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Capture {
  out = "";
  push(chunk: Uint8Array): void {
    this.out = (this.out + new TextDecoder().decode(chunk)).slice(-24_000);
  }
  tail(max = 1_200): string {
    const t = this.out.trim();
    return t.length > max ? `…${t.slice(-max)}` : t;
  }
}

async function pump(stream: ReadableStream<Uint8Array> | null, cap: Capture): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) cap.push(value);
    }
  } catch {
    /* torn down with the child */
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

async function waitHttp(url: string, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  let last = "no response";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      last = `HTTP ${res.status}`;
      if (res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 80) : String(err);
    }
    await sleep(400);
  }
  throw new Error(`${what}: not ready after ${timeoutMs}ms (last: ${last})`);
}

interface ManifestEntry {
  id?: string;
  url?: string;
  domUrl?: string;
  source?: string;
  origin?: string;
  disabled?: boolean;
}

async function getManifest(): Promise<{ data: ManifestEntry[]; version: number }> {
  const res = await fetch(`${BASE}/api/webui/extensions`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const body = (await res.json()) as { data?: ManifestEntry[]; version?: number };
  return { data: Array.isArray(body.data) ? body.data : [], version: body.version ?? -1 };
}

async function pollManifest(
  pred: (data: ManifestEntry[]) => boolean,
  timeoutMs: number,
): Promise<ManifestEntry[] | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const { data } = await getManifest();
      if (pred(data)) return data;
    } catch {
      /* proxy hiccup — keep polling */
    }
    await sleep(POLL_MS);
  }
  return null;
}

/** Open the SSE push channel, wait for the hello, then run `write` and time the next version bump. */
async function timeSsePush(write: () => void): Promise<{ ms: number; from: number; to: number }> {
  const res = await fetch(`${BASE}/api/webui/extensions/events`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok || !res.body) throw new Error(`SSE channel HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let hello: number | null = null;
  let wrote = false;
  let tWrite = 0;
  const t0 = Date.now();
  try {
    for (;;) {
      if (Date.now() - t0 > 20_000) throw new Error("SSE push wait timed out (20s)");
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream closed before push");
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        for (const line of part.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          let msg: { type?: string; version?: number };
          try {
            msg = JSON.parse(t.slice("data:".length).trim()) as { type?: string; version?: number };
          } catch {
            continue;
          }
          if (msg.type !== "webui.extensions" || typeof msg.version !== "number") continue;
          if (hello === null) {
            hello = msg.version;
            await sleep(100); // let the hello settle; the write lands strictly after
            tWrite = Date.now();
            write();
            wrote = true;
          } else if (wrote && msg.version > hello) {
            return { ms: Date.now() - tWrite, from: hello, to: msg.version };
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures (external-dir format: window bridge + external react)
// ---------------------------------------------------------------------------

function manifestJson(id: string, disabled: boolean): string {
  const base: Record<string, unknown> = {
    id,
    name: id,
    version: "1.0.0",
    description: `battery fixture ${id}`,
  };
  if (disabled) base["disabled"] = true;
  return JSON.stringify(base, null, 2);
}

function batTimeSource(marker: "v1" | "v2"): string {
  const upper = marker.toUpperCase();
  return `// Battery fixture ${EXT_ID} (${marker}) — external-dir format.
import { useState } from "react";
const ui = (globalThis as unknown as { __opencodeUI?: { register?: (e: unknown) => void } }).__opencodeUI;
void useState;
ui?.register?.({
  kind: "contribute",
  id: "${EXT_ID}.cmd",
  collection: "palette",
  item: { title: "BAT_TIME_${upper}", run: () => {} },
});
`;
}

function statefulSource(): string {
  return `// Battery fixture ${STATEFUL_ID} — useState must survive bundling via external react.
import { useState } from "react";
const ui = (globalThis as unknown as { __opencodeUI?: { register?: (e: unknown) => void } }).__opencodeUI;
function Counter() {
  const [n, setN] = useState(0);
  return null as unknown as string;
}
void Counter;
ui?.register?.({
  kind: "contribute",
  id: "${STATEFUL_ID}.page",
  collection: "pages",
  item: { title: "BAT_STATEFUL", render: () => null },
});
`;
}

function shadowSource(): string {
  return `// Battery shadow of shipped "${SHADOW_ID}" — higher precedence must win.
const ui = (globalThis as unknown as { __opencodeUI?: { register?: (e: unknown) => void } }).__opencodeUI;
ui?.register?.({
  kind: "contribute",
  id: "bat-shadow.cmd",
  collection: "palette",
  item: { title: "BAT_SHADOW", run: () => {} },
});
`;
}

// ---------------------------------------------------------------------------
// Recursive grep (M3/G1) — self excluded (this file documents the patterns)
// ---------------------------------------------------------------------------

function walkTs(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (p === SELF) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTs(p, out);
    else if (/\.(tsx?|mts|cts)$/.test(name)) out.push(p);
  }
}

function grepFiles(roots: string[], re: RegExp): string[] {
  const files: string[] = [];
  for (const r of roots) {
    if (existsSync(r)) {
      const st = statSync(r);
      if (st.isDirectory()) walkTs(r, files);
      else files.push(r);
    }
  }
  const hits: string[] = [];
  for (const f of files) {
    if (f === SELF) continue;
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i] ?? "")) hits.push(`${f}:${i + 1}:${(lines[i] ?? "").trim().slice(0, 120)}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Child proxy (module-scoped so `finally` sees it)
// ---------------------------------------------------------------------------

const cap = new Capture();
let proxyProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;

async function cleanup(): Promise<void> {
  if (proxyProc && pidAlive(proxyProc.pid)) {
    try {
      proxyProc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && pidAlive(proxyProc.pid)) await sleep(150);
    if (pidAlive(proxyProc.pid)) {
      try {
        proxyProc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  for (const dir of [EXT_DIR, STATEFUL_DIR, SHADOW_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  rmSync(BAT_DIR, { recursive: true, force: true });
  mkdirSync(BAT_DIR, { recursive: true });

  // --- Setup: isolated proxy ---
  const tSetup = Date.now();
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  childEnv["WEBUI_EXTENSION_DIR"] = BAT_DIR;
  childEnv["WEBUI_PROXY_PORT"] = String(PROXY_PORT);
  childEnv["WEBUI_SANDBOX"] = "1";
  childEnv["WEBUI_HOST"] = "127.0.0.1";
  delete childEnv["WEBUI_PASSWORD"]; // sandbox is passwordless by construction
  proxyProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  void pump(proxyProc.stdout, cap);
  void pump(proxyProc.stderr, cap);
  const proxyPid = proxyProc.pid;
  await waitHttp(`${BASE}/api/webui/extensions`, 60_000, "isolated proxy");
  rows.push({
    label: "SETUP isolated proxy (4114, sandbox, scratch dir)",
    status: "PASS",
    detail: `pid ${proxyPid} · passwordless sandbox · ext dir ${BAT_DIR}`,
    secs: Date.now() - tSetup,
  });
  const pidSame = (): boolean => proxyProc !== null && proxyProc.pid === proxyPid && pidAlive(proxyPid);

  // --- L1: hot ADD ---
  {
    const t0 = Date.now();
    mkdirSync(EXT_DIR, { recursive: true });
    writeFileSync(join(EXT_DIR, "manifest.json"), manifestJson(EXT_ID, false));
    writeFileSync(join(EXT_DIR, "index.tsx"), batTimeSource("v1"));
    const data = await pollManifest((d) => d.some((e) => e.id === EXT_ID && typeof e.url === "string"), 20_000);
    const entry = data?.find((e) => e.id === EXT_ID);
    let bundleOk = false;
    let bundleDetail = "manifest never listed it";
    if (entry?.url) {
      const res = await fetch(`${BASE}${entry.url}`, { signal: AbortSignal.timeout(5_000) });
      const js = await res.text().catch(() => "");
      bundleOk = res.status === 200 && js.includes("BAT_TIME_V1");
      bundleDetail = `bundle HTTP ${res.status}, ${js.length}b, marker ${js.includes("BAT_TIME_V1") ? "present" : "MISSING"}`;
    }
    const ok = entry !== undefined && bundleOk && pidSame();
    rows.push({
      label: "L1 drop folder → loads (no rebuild/refresh/restart)",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `manifest lists "${EXT_ID}" (origin ${entry?.origin ?? "?"}) · ${bundleDetail} · proxy pid ${proxyPid} unchanged`
        : `entry: ${entry ? JSON.stringify(entry).slice(0, 160) : "absent"} · ${bundleDetail} · pidSame=${pidSame()}\nproxy tail:\n${cap.tail(600)}`,
      secs: Date.now() - t0,
    });
  }
  const l1Url = (await getManifest().catch(() => ({ data: [], version: -1 }))).data.find(
    (e) => e.id === EXT_ID,
  )?.url;

  // Steady-state pause: the proxy attaches per-folder watchers on its 5s
  // sweep (parent-root inotify reports only direct-child create/delete, never
  // content edits inside a new folder). Editing within ~5s of the folder's
  // creation would race that attach and fall through to the 5s backstop —
  // real authors edit long after adding, so wait one sweep here.
  await sleep(6_000);

  // --- L2: hot EDIT → SSE push, bumped ?v=, sub-second ---
  {
    const t0 = Date.now();
    let push: { ms: number; from: number; to: number } | null = null;
    let pushErr: string | null = null;
    try {
      push = await timeSsePush(() => {
        writeFileSync(join(EXT_DIR, "index.tsx"), batTimeSource("v2"));
      });
    } catch (err) {
      pushErr = err instanceof Error ? err.message : String(err);
    }
    const data = await pollManifest(
      (d) => d.some((e) => e.id === EXT_ID && typeof e.url === "string" && e.url !== l1Url),
      10_000,
    );
    const entry = data?.find((e) => e.id === EXT_ID);
    let bundleOk = false;
    if (entry?.url) {
      const res = await fetch(`${BASE}${entry.url}`, { signal: AbortSignal.timeout(5_000) });
      const js = await res.text().catch(() => "");
      bundleOk = res.status === 200 && js.includes("BAT_TIME_V2") && !js.includes("BAT_TIME_V1");
    }
    const subSecond = push !== null && push.ms < 1_000;
    const ok = subSecond && entry?.url !== l1Url && bundleOk && pidSame();
    rows.push({
      label: "L2 edit → SSE push with bumped ?v= (sub-second)",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `push v${push?.from}→v${push?.to} in ${push?.ms}ms (<1000ms) · ?v= ${l1Url?.split("v=")[1] ?? "?"}→${entry?.url?.split("v=")[1] ?? "?"} · bundle serves V2 only`
        : `push: ${push ? `${push.ms}ms` : `FAILED (${pushErr ?? "?"})`} · ?v= bumped=${entry?.url !== l1Url} · bundleV2=${bundleOk}\nproxy tail:\n${cap.tail(600)}`,
      secs: Date.now() - t0,
    });
  }

  // --- L3: disabled flip → paused ---
  {
    const t0 = Date.now();
    writeFileSync(join(EXT_DIR, "manifest.json"), manifestJson(EXT_ID, true));
    const data = await pollManifest((d) => d.some((e) => e.id === EXT_ID && e.disabled === true), 15_000);
    const entry = data?.find((e) => e.id === EXT_ID);
    const res = await fetch(`${BASE}/api/webui/extensions/${EXT_ID}/bundle.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    await res.arrayBuffer().catch(() => undefined);
    const ok = entry?.disabled === true && entry.url === undefined && res.status === 404 && pidSame();
    rows.push({
      label: "L3 disabled:true → paused",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `manifest shows { disabled:true } with no url · bundle.js → 404`
        : `entry: ${entry ? JSON.stringify(entry).slice(0, 160) : "absent"} · bundle HTTP ${res.status}`,
      secs: Date.now() - t0,
    });
  }

  // --- L4: re-enable ---
  {
    const t0 = Date.now();
    writeFileSync(join(EXT_DIR, "manifest.json"), manifestJson(EXT_ID, false));
    const data = await pollManifest((d) => d.some((e) => e.id === EXT_ID && typeof e.url === "string"), 15_000);
    const entry = data?.find((e) => e.id === EXT_ID);
    const ok = entry !== undefined && entry.disabled !== true && typeof entry.url === "string";
    rows.push({
      label: "L4 disabled removed → resumes",
      status: ok ? "PASS" : "FAIL",
      detail: ok ? `manifest lists "${EXT_ID}" with url again` : `entry: ${entry ? JSON.stringify(entry).slice(0, 160) : "absent"}`,
      secs: Date.now() - t0,
    });
  }

  // --- L5: delete → uninstalled ---
  {
    const t0 = Date.now();
    rmSync(EXT_DIR, { recursive: true, force: true });
    const data = await pollManifest((d) => !d.some((e) => e.id === EXT_ID), 15_000);
    const gone = data !== null && !data.some((e) => e.id === EXT_ID);
    const res = await fetch(`${BASE}/api/webui/extensions/${EXT_ID}/bundle.js`, {
      signal: AbortSignal.timeout(5_000),
    });
    await res.arrayBuffer().catch(() => undefined);
    const ok = gone && res.status === 404 && pidSame();
    rows.push({
      label: "L5 delete folder → uninstalled",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `id vanished from manifest · bundle.js → 404 · proxy pid ${proxyPid} alive throughout L1–L5`
        : `gone=${gone} · bundle HTTP ${res.status} · pidSame=${pidSame()}`,
      secs: Date.now() - t0,
    });
  }

  // --- P1: precedence user > project > shipped (static order + live shadow) ---
  {
    const t0 = Date.now();
    const userExt = readFileSync(join(ROOT, "server", "userExtensions.ts"), "utf8");
    const iu = userExt.indexOf("globalUserExtensionsDir()");
    const ip = userExt.indexOf("projectUserExtensionsDir()");
    const is = userExt.indexOf("shippedExtensionsDir()");
    const orderOk = iu > 0 && ip > 0 && is > 0 && iu < ip && ip < is;
    // Live: shadow shipped `report` from the scratch (user) dir.
    mkdirSync(SHADOW_DIR, { recursive: true });
    writeFileSync(join(SHADOW_DIR, "manifest.json"), manifestJson(SHADOW_ID, false));
    writeFileSync(join(SHADOW_DIR, "index.tsx"), shadowSource());
    const shadowed = await pollManifest(
      (d) => d.filter((e) => e.id === SHADOW_ID).length === 1 && d.some((e) => e.id === SHADOW_ID && e.origin === "user"),
      20_000,
    );
    const shadowEntry = shadowed?.find((e) => e.id === SHADOW_ID);
    let shadowBundleOk = false;
    if (shadowEntry?.url) {
      const res = await fetch(`${BASE}${shadowEntry.url}`, { signal: AbortSignal.timeout(5_000) });
      const js = await res.text().catch(() => "");
      shadowBundleOk = res.status === 200 && js.includes("BAT_SHADOW");
    }
    // Unshadow: shipped copy must return, exactly once, with no bundle url (P2).
    rmSync(SHADOW_DIR, { recursive: true, force: true });
    const restored = await pollManifest(
      (d) => d.filter((e) => e.id === SHADOW_ID).length === 1 && d.some((e) => e.id === SHADOW_ID && e.origin === "shipped"),
      20_000,
    );
    const restoredEntry = restored?.find((e) => e.id === SHADOW_ID);
    const ok = orderOk && shadowEntry?.origin === "user" && shadowBundleOk && restoredEntry?.origin === "shipped";
    rows.push({
      label: "P1 precedence user>project>shipped",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `scan order user(${iu})<project(${ip})<shipped(${is}) · shadow won (origin user, BAT_SHADOW serves) · unshadow restored shipped`
        : `orderOk=${orderOk} · shadow=${shadowEntry ? JSON.stringify(shadowEntry).slice(0, 140) : "absent"} bundle=${shadowBundleOk} · restored=${restoredEntry ? JSON.stringify(restoredEntry).slice(0, 140) : "absent"}`,
      secs: Date.now() - t0,
    });
  }

  // --- P2: shipped loads exactly ONCE ---
  {
    const t0 = Date.now();
    const { data } = await getManifest();
    const shipped = data.filter((e) => e.origin === "shipped");
    const report = data.filter((e) => e.id === SHADOW_ID);
    const noShippedUrls = shipped.every((e) => e.url === undefined);
    const serverIdx = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    const runtime = readFileSync(join(ROOT, "src", "lib", "runtimeExtensions.ts"), "utf8");
    const proxyGuard = serverIdx.includes('e.origin !== "shipped"');
    const runtimeGuard = runtime.includes('entry.origin === "shipped"');
    const ok = report.length === 1 && noShippedUrls && proxyGuard && runtimeGuard;
    rows.push({
      label: "P2 shipped loads exactly ONCE",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `"report" listed once (origin shipped, no url → glob-owned, never double-imported) · proxy omits shipped url · runtime skips shipped import`
        : `report entries=${report.length} · shippedWithUrl=${shipped.filter((e) => e.url !== undefined).length} · proxyGuard=${proxyGuard} runtimeGuard=${runtimeGuard}`,
      secs: Date.now() - t0,
    });
  }

  // --- G1: manifest gating is the ONLY gate ---
  {
    const t0 = Date.now();
    const roots = [join(ROOT, "src"), join(ROOT, "server"), join(ROOT, "scripts"), join(ROOT, "webui-extensions")];
    const configRefs = grepFiles(roots, /ui-extensions\/config|webui-extensions\/config/);
    const loaderLocalStorage = grepFiles(
      [join(ROOT, "src", "extensions"), join(ROOT, "src", "lib", "runtimeExtensions.ts"), join(ROOT, "src", "lib", "extensionApi.ts"), join(ROOT, "server")],
      /localStorage/,
    ).filter((h) => !/no .*localStorage|ungated/i.test(h));
    const legacyConfigFile = existsSync(join(ROOT, "webui-extensions", "config.ts")) || existsSync(join(ROOT, "ui-extensions"));
    // Proven live by L3/L4 (disabled flip paused + resumed via manifest alone).
    const l3 = rows.find((r) => r.label.startsWith("L3"))?.status === "PASS";
    const l4 = rows.find((r) => r.label.startsWith("L4"))?.status === "PASS";
    const ok = configRefs.length === 0 && loaderLocalStorage.length === 0 && !legacyConfigFile && l3 && l4;
    rows.push({
      label: "G1 manifest gating is the ONLY gate",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `no config.ts refs · no localStorage in loader/registry/server paths (extKv KV store excepted — namespaced webui.extkv.*, not gating) · L3+L4 proved manifest-driven pause/resume`
        : `configRefs=${configRefs.length} ${configRefs.slice(0, 3).join(" | ")} · loaderLocalStorage=${loaderLocalStorage.length} ${loaderLocalStorage.slice(0, 3).join(" | ")} · legacyFile=${legacyConfigFile} · L3=${l3} L4=${l4}`,
      secs: Date.now() - t0,
    });
  }

  // --- T1: §5.4 wrap — tweak + sibling redesign + new badge all visible ---
  {
    const t0 = Date.now();
    const stamp = Date.now().toString(36);
    const TS = `t1-ts-${stamp}`;
    const TOK = `t1-tok-${stamp}`;
    const COST = `t1-cost-${stamp}`;
    const BADGE = `t1-badge-${stamp}`;
    const WRAP = `t1-wrap-${stamp}`;
    const FMT = (ms: unknown): string => `FMT(${String(ms)})`;
    registerTarget(TS, (p) => React.createElement("time", null, `core-clock:${String(p["time"] ?? "")}`));
    registerTarget(TOK, () => React.createElement("span", null, "TOKENS-v1"));
    registerTarget(COST, () => React.createElement("span", null, "COST-v1"));
    // NOTE: wrap and service use DISTINCT ids. The registry holds one
    // entry per id (same-id re-register swaps in place), so sharing one id
    // across two entries would evict the first — the timestamp-test.md
    // sketch reuses "my-time" for both, which does not survive register().
    register({
      kind: "wrap",
      id: WRAP,
      target: TS,
      render: (_props, next) => React.createElement("span", { className: "tabular-nums" }, next()),
    });
    register({ kind: "service", id: `${WRAP}-svc`, service: `format.timestamp.${stamp}`, value: FMT, precedence: 10 });
    const before = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderTarget(TS, { time: 123 }),
        renderTarget(TOK, {}),
        renderTarget(COST, {}),
      ),
    );
    const beforeOk = before.includes("tabular-nums") && before.includes("core-clock:123") && before.includes("TOKENS-v1");
    // Maintainer redesign: siblings change, timestamp target untouched.
    registerTarget(TOK, () => React.createElement("span", { className: "tokens-redesigned" }, "TOKENS-v2-redesigned"));
    registerTarget(BADGE, () => React.createElement("span", null, "FINISH-BADGE"));
    const after = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderTarget(TS, { time: 123 }),
        renderTarget(TOK, {}),
        renderTarget(BADGE, {}),
      ),
    );
    const afterOk =
      after.includes("tabular-nums") && // wrap intact
      after.includes("core-clock:123") && // timestamp still delegated
      after.includes("TOKENS-v2-redesigned") && // sibling redesign visible
      after.includes("FINISH-BADGE"); // new sibling visible
    unregisterIds([WRAP]);
    const ok = beforeOk && afterOk;
    rows.push({
      label: "T1 §5.4 wrap: tweak + sibling redesign both visible",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `wrap delegates (tabular-nums + core-clock) · redesign flows through (TOKENS-v2 + FINISH-BADGE)`
        : `before=${beforeOk} after=${afterOk} · after-html: ${after.slice(0, 220)}`,
      secs: Date.now() - t0,
    });
  }

  // --- T2: §5.4 replace — ownership is legible ---
  {
    const t0 = Date.now();
    const stamp = Date.now().toString(36);
    const TS = `t2-ts-${stamp}`;
    const TOK = `t2-tok-${stamp}`;
    const OWN = `t2-own-${stamp}`;
    registerTarget(TS, () => React.createElement("time", null, "core-clock-v2"));
    registerTarget(TOK, () => React.createElement("span", null, "TOKENS-v2-redesigned"));
    register({
      kind: "replace",
      id: OWN,
      target: TS,
      render: (_props, _core) => React.createElement("span", { className: "my-clock" }, "MY-CLOCK"),
    });
    const html = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderTarget(TS, {}), renderTarget(TOK, {})),
    );
    const ownsUnit = html.includes("MY-CLOCK") && !html.includes("core-clock-v2");
    const siblingFlows = html.includes("TOKENS-v2-redesigned");
    unregisterIds([OWN]);
    const ok = ownsUnit && siblingFlows;
    rows.push({
      label: "T2 §5.4 replace: ownership legible",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `timestamp frozen on MY-CLOCK (core redesign correctly NOT shown) · sibling still live (TOKENS-v2)`
        : `ownsUnit=${ownsUnit} siblingFlows=${siblingFlows} · html: ${html.slice(0, 220)}`,
      secs: Date.now() - t0,
    });
  }

  // --- S1: shared-React guard — useState bundle keeps react external ---
  {
    const t0 = Date.now();
    mkdirSync(STATEFUL_DIR, { recursive: true });
    writeFileSync(join(STATEFUL_DIR, "manifest.json"), manifestJson(STATEFUL_ID, false));
    writeFileSync(join(STATEFUL_DIR, "index.tsx"), statefulSource());
    const data = await pollManifest((d) => d.some((e) => e.id === STATEFUL_ID && typeof e.url === "string"), 20_000);
    const entry = data?.find((e) => e.id === STATEFUL_ID);
    let js = "";
    let status = 0;
    if (entry?.url) {
      const res = await fetch(`${BASE}${entry.url}`, { signal: AbortSignal.timeout(5_000) });
      status = res.status;
      js = await res.text().catch(() => "");
    }
    const hasExternalReact = /from\s*["']react["']|from\s*["']react\/jsx-(dev-)?runtime["']/.test(js);
    const looksInlined =
      js.includes("__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED") ||
      js.includes("ReactCurrentOwner") ||
      /function useState\(/.test(js);
    const smallEnough = js.length > 0 && js.length < 50_000; // a vendored React would be 10x this
    const serverIdx = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    const buildExternal = serverIdx.includes('"react/jsx-runtime"') && serverIdx.includes('external: ["react"');
    const vendorRes = await fetch(`${BASE}/api/webui/vendor/react.js`, { signal: AbortSignal.timeout(5_000) });
    const vendorJs = await vendorRes.text().catch(() => "");
    const vendorOk =
      vendorRes.status === 200 && vendorJs.includes("__opencodeUI") && vendorJs.includes("useState");
    rmSync(STATEFUL_DIR, { recursive: true, force: true });
    const ok = status === 200 && hasExternalReact && !looksInlined && smallEnough && buildExternal && vendorOk;
    rows.push({
      label: "S1 stateful ext keeps react external (shared-React guard)",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `bundle ${js.length}b imports bare "react" (not inlined) · Bun.build external[] covers react/jsx runtimes · vendor shim re-exports app React incl. useState`
        : `http=${status} external=${hasExternalReact} inlined=${looksInlined} size=${js.length} buildExternal=${buildExternal} vendor=${vendorOk}`,
      secs: Date.now() - t0,
    });
  }

  // --- M1: gen:skill exits 0 ---
  {
    const t0 = Date.now();
    const proc = Bun.spawn(["bun", "run", "gen:skill"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outCap = new Capture();
    void pump(proc.stdout, outCap);
    void pump(proc.stderr, outCap);
    const code = await proc.exited;
    const ok = code === 0;
    rows.push({
      label: "M1 bun run gen:skill exits 0",
      status: ok ? "PASS" : "FAIL",
      detail: ok ? outCap.tail(200).split("\n").pop() ?? "exit 0" : `exit ${code}\n${outCap.tail(600)}`,
      secs: Date.now() - t0,
    });
  }

  // --- M2: typecheck green ---
  {
    const t0 = Date.now();
    const proc = Bun.spawn(["bun", "run", "typecheck"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outCap = new Capture();
    void pump(proc.stdout, outCap);
    void pump(proc.stderr, outCap);
    const code = await Promise.race([proc.exited, sleep(300_000).then(() => -1)]);
    if (code === -1) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Attribute failures: this battery is green iff tsc is clean; when a
    // sibling's in-flight file breaks the repo-wide run, name the files so
    // the owner is obvious (this file must never be among them).
    const errFiles = new Set<string>();
    for (const line of outCap.out.split("\n")) {
      const m = line.match(/^([^(]+)\(/);
      if (m?.[1]) errFiles.add(m[1].trim());
    }
    const selfClean = !errFiles.has("scripts/uitest/ext-battery-acceptance.ts");
    const ok = code === 0;
    rows.push({
      label: "M2 bun run typecheck green",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `tsc --noEmit clean`
        : `exit ${code} · this file clean=${selfClean} · error files: ${[...errFiles].slice(0, 6).join(", ") || "?"}\n${outCap.tail(800)}`,
      secs: Date.now() - t0,
    });
  }

  // --- M3: grep-clean ---
  {
    const t0 = Date.now();
    const roots = [join(ROOT, "src"), join(ROOT, "server"), join(ROOT, "scripts"), join(ROOT, "webui-extensions")];
    const slotHits = grepFiles(roots, /<Slot[\s>]/);
    const legacyKindHits = grepFiles(
      roots,
      /kind\s*:\s*["'](region|message|tool\.renderer|command|slash|page|settings|contextMenu)["']/,
    );
    const configHits = grepFiles(roots, /ui-extensions\/config|webui-extensions\/config/);
    const legacyGetterHits = grepFiles(roots, /getSlot|getRegion|Slot region/);
    const staleDir = existsSync(join(ROOT, "ui-extensions"));
    const all = [...slotHits, ...legacyKindHits, ...configHits, ...legacyGetterHits];
    const ok = all.length === 0 && !staleDir;
    rows.push({
      label: "M3 grep-clean (no Slot/legacy/config refs)",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `0 hits across src/server/scripts/webui-extensions (self excluded) · no ui-extensions/ dir · Radix Slot imports + message.part/decoration contribute-collections intentionally untouched`
        : `hits=${all.length} ${all.slice(0, 5).join(" | ")} · staleDir=${staleDir}`,
      secs: Date.now() - t0,
    });
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function report(): void {
  const width = Math.max(...rows.map((r) => r.label.length), 30);
  console.log("\n=== ext loader + acceptance battery (spec §6 + §13) ===");
  for (const r of rows) {
    const secs = r.secs !== undefined ? ` (${(r.secs / 1000).toFixed(1)}s)` : "";
    console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}${secs}`);
    if (r.detail) {
      for (const line of r.detail.split("\n")) console.log(`     ${line}`);
    }
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const skip = rows.filter((r) => r.status === "SKIP").length;
  console.log(`\nRESULT: ${pass} pass · ${fail} fail · ${skip} skip → exit ${fail > 0 ? 1 : 0}`);
}

let code = 0;
try {
  await main();
} catch (err) {
  rows.push({
    label: "SETUP (fatal)",
    status: "FAIL",
    detail:
      (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 2_000) +
      (cap.out.trim() ? `\nproxy tail:\n${cap.tail(1_500)}` : ""),
  });
  code = 1;
} finally {
  await cleanup();
  report();
}
await sleep(50);
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : code);
