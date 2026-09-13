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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getContributions,
  getHooks,
  getRegisteredIds,
  getService,
  getServiceProviders,
  getTargetChain,
  hasTarget,
  listCollections,
  register,
  registerTarget,
  renderTarget,
  unregisterIds,
} from "../../src/extensions/registry";
import { Slot, SLOT_IDS } from "../../src/extensions/slots";
import { publishPeerEvent } from "../../src/lib/extBus";
import { fireHooks } from "../../src/extensions/hooks";
import { activateExtension, type ExtensionContext } from "../../src/extensions/context";
import { startScheduler, stopScheduler } from "../../src/lib/scheduler";
import { publishEvent, subscribeEvents, flushEvents } from "../../src/lib/eventBus";
import { handleEvent, setPendingWorkspace } from "../../src/store";
import type { V2Event } from "../../src/api/events";
import { parseManifestContract, resolveSettings, checkRequires } from "../../src/extensions/manifest";
import {
  registerExtensionSchema,
  resolvedExtensionSettings,
  setExtensionSetting,
  extensionSettings,
} from "../../src/lib/extSettings";
import {
  registerKnownSlots,
  isKnownSlot,
  setExtensionDiagnostics,
  getExtensionDiagnostics,
  clearExtensionDiagnostics,
} from "../../src/lib/extensionDiagnostics";

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

function testWrapPropTransform(): void {
  const t0 = Date.now();
  const label = "wrap transforms props (next overrides merge down-chain)";
  const ids = ["bat-wp-outer", "bat-wp-inner"];
  const target = "bat.target.props";
  unregisterIds(ids);
  try {
    registerTarget(target, (p) => `CORE:${String(p.mode ?? "none")}:${String(p.extra ?? "-")}`);
    register({
      kind: "wrap",
      id: ids[0]!,
      target,
      order: 10,
      render: (props, next) =>
        `OUTER[${String(next({ mode: "outer", extra: String(props.seed) === "s1" ? "e1" : "e0" }))}]`,
    });
    // The inner wrap must RECEIVE the outer's merged props, not the originals.
    register({
      kind: "wrap",
      id: ids[1]!,
      target,
      order: 20,
      render: (props, next) =>
        `INNER(${String(props.mode)}:${String(props.extra)})[${String(next())}]`,
    });
    const out = renderTarget(target, { seed: "s1" }) as unknown;
    if (out !== "OUTER[INNER(outer:e1)[CORE:outer:e1]]") {
      fail(label, `expected OUTER[INNER(outer:e1)[CORE:outer:e1]], got ${JSON.stringify(out)}`, t0);
      return;
    }
    // A wrap that calls next() with no overrides keeps props unchanged.
    unregisterIds([ids[0]!]);
    const plain = renderTarget(target, { mode: "orig" }) as unknown;
    if (plain !== "INNER(orig:undefined)[CORE:orig:-]") {
      fail(label, `no-override delegate changed props: ${JSON.stringify(plain)}`, t0);
      return;
    }
    pass(label, `outer override reached inner wrap + core; no-arg next() untouched`, t0);
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

async function testActivationContext(): Promise<void> {
  const t0 = Date.now();
  const label = "activation context: register + dispose + teardown";
  const ids = ["bat-ctx-wrap", "bat-ctx-svc", "bat-ctx-throw"];
  const target = "bat.target.ctx";
  unregisterIds(ids);
  try {
    registerTarget(target, () => "CORE");
    const order: string[] = [];
    const inst = await activateExtension("bat-ctx", {
      id: "bat-ctx",
      activate(ctx: ExtensionContext) {
        ctx.register({
          kind: "wrap",
          id: ids[0]!,
          target,
          render: (_p, next) => `W[${String(next())}]`,
        });
        ctx.register({ kind: "service", id: ids[1]!, service: "bat.svc.ctx", value: 7, precedence: 1 });
        ctx.onDispose(() => order.push("first"));
        ctx.onDispose(() => {
          order.push("boom");
          throw new Error("boom (battery dispose probe)");
        });
        ctx.onDispose(() => order.push("last"));
        return () => order.push("returned");
      },
    });
    if (!inst.activated) {
      fail(label, `activated=false for a module with activate`, t0);
      return;
    }
    if ((renderTarget(target, {}) as unknown) !== "W[CORE]" || getService("bat.svc.ctx") !== 7) {
      fail(label, `ctx.register entries not live`, t0);
      return;
    }
    inst.dispose();
    if ((renderTarget(target, {}) as unknown) !== "CORE" || getService("bat.svc.ctx") !== undefined) {
      fail(label, `owned ids not unregistered on dispose`, t0);
      return;
    }
    // LIFO: returned teardown was registered last → runs first; the throwing
    // disposer is isolated and does not strand the ones before it.
    const expected = ["returned", "last", "boom", "first"].join(",");
    if (order.join(",") !== expected) {
      fail(label, `teardown order ${order.join(",")} (want ${expected})`, t0);
      return;
    }
    inst.dispose(); // idempotent
    if (order.join(",") !== expected) {
      fail(label, `dispose not idempotent: ${order.join(",")}`, t0);
      return;
    }
    // Ambient module → inert instance (the loader keeps its id-delta path).
    const ambient = await activateExtension("bat-ambient", { id: "bat-ambient" });
    if (ambient.activated || ambient.ownedIds.length > 0) {
      fail(label, `ambient module not inert`, t0);
      return;
    }
    // A throwing activate is isolated, and ids registered before the throw
    // are still owned + pruned on dispose.
    const crash = await activateExtension("bat-ctx-throw", {
      activate(ctx: ExtensionContext) {
        ctx.register({ kind: "wrap", id: ids[2]!, target, render: () => "THROWN" });
        throw new Error("activate boom (battery probe)");
      },
    });
    if (!crash.activated || (renderTarget(target, {}) as unknown) !== "THROWN") {
      fail(label, `throwing activate not isolated (activated=${crash.activated})`, t0);
      return;
    }
    crash.dispose();
    if ((renderTarget(target, {}) as unknown) !== "CORE") {
      fail(label, `throwing-activate owned id not pruned on dispose`, t0);
      return;
    }
    pass(label, `ctx ids pruned; teardown LIFO + crash-isolated (${order.join("→")})`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    unregisterIds(ids);
  }
}

async function testContextScheduler(): Promise<void> {
  const t0 = Date.now();
  const label = "context scheduler: poll + after, disposed on teardown";
  let pollCount = 0;
  let afterFired = 0;
  let cancelFired = 0;
  const inst = await activateExtension("bat-sched", {
    activate(ctx: ExtensionContext) {
      ctx.poll({ name: "tick", minInterval: 200, run: () => { pollCount++; } });
      ctx.after(20, () => { afterFired++; });
      const cancel = ctx.after(20, () => { cancelFired++; });
      cancel();
    },
  });
  startScheduler({ isBusy: () => true, isSseStale: () => false });
  try {
    await sleep(1_250); // one scheduler tick (the loop evaluates every 1s)
    if (pollCount < 1) {
      fail(label, `poller never ran (count=${pollCount})`, t0);
      return;
    }
    if (afterFired !== 1 || cancelFired !== 0) {
      fail(label, `after: fired=${afterFired}, cancelled fired=${cancelFired}`, t0);
      return;
    }
    const atDispose = pollCount;
    inst.dispose();
    await sleep(1_250);
    if (pollCount !== atDispose) {
      fail(label, `poller ran after dispose (${atDispose} → ${pollCount})`, t0);
      return;
    }
    pass(label, `poller ran ${atDispose}×; one-shot fired once, cancel held; stopped on dispose`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    inst.dispose();
    stopScheduler();
  }
}

async function testEventBus(): Promise<void> {
  const t0 = Date.now();
  const label = "event bus: exact + wildcard + unsubscribe + ctx.on disposal";
  const got: string[] = [];
  const unsubExact = subscribeEvents("tool.completed", (e) =>
    got.push(`exact:${e.name}:${String((e.payload as { name?: string }).name)}`),
  );
  const unsubWild = subscribeEvents("*", (e) => got.push(`wild:${e.name}`));
  try {
    publishEvent("tool.completed", { sessionID: "s1", payload: { name: "read" } });
    publishEvent("run.started", { sessionID: "s1", payload: {} });
    await sleep(40);
    const expected = ["exact:tool.completed:read", "wild:tool.completed", "wild:run.started"].join(",");
    if (got.join(",") !== expected) {
      fail(label, `dispatch ${got.join(",")} (want ${expected})`, t0);
      return;
    }
    // Unsubscribe stops delivery.
    unsubExact();
    unsubWild();
    const before = got.length;
    publishEvent("tool.completed", { payload: { name: "again" } });
    await sleep(40);
    if (got.length !== before) {
      fail(label, `unsubscribe leaked (${got.length - before} extra)`, t0);
      return;
    }
    // Crash isolation: a throwing listener must not stop its peers.
    let good = 0;
    const unsubBoom = subscribeEvents("bat.boom", () => {
      throw new Error("boom (battery bus probe)");
    });
    const unsubGood = subscribeEvents("bat.boom", () => {
      good++;
    });
    publishEvent("bat.boom", { payload: {} });
    await sleep(40);
    unsubBoom();
    unsubGood();
    if (good !== 1) {
      fail(label, `throwing listener not isolated (good=${good})`, t0);
      return;
    }
    // ctx.on is removed when the extension instance is disposed.
    let ctxGot = 0;
    const inst = await activateExtension("bat-bus", {
      activate(ctx: ExtensionContext) {
        ctx.on("run.ended", () => {
          ctxGot++;
        });
      },
    });
    publishEvent("run.ended", { payload: {} });
    await sleep(40);
    if (ctxGot !== 1) {
      fail(label, `ctx.on did not receive (${ctxGot})`, t0);
      return;
    }
    inst.dispose();
    publishEvent("run.ended", { payload: {} });
    await sleep(40);
    if (ctxGot !== 1) {
      fail(label, `ctx.on leaked after dispose (${ctxGot})`, t0);
      return;
    }
    pass(label, `exact+wildcard ordered; unsubscribe + ctx disposal hold; crash-isolated`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    unsubExact();
    unsubWild();
  }
}

async function testStoreEventIntegration(): Promise<void> {
  const t0 = Date.now();
  const label = "store event integration: raw + derived (tool/run)";
  const got: string[] = [];
  const offs = [
    subscribeEvents("session.tool.success", (e) => got.push(`raw:${e.name}`)),
    subscribeEvents("tool.called", (e) => got.push(`called:${String((e.payload as { name?: string }).name)}`)),
    subscribeEvents("tool.completed", (e) => got.push(`completed:${String((e.payload as { ok?: boolean }).ok)}`)),
    subscribeEvents("run.started", () => got.push("run.started")),
  ];
  try {
    const sid = "bat-store-evt";
    const send = (id: string, created: number, type: string, data: Record<string, unknown>) =>
      handleEvent({ id, created, type, data } as unknown as V2Event);
    // Network-free cases only: tool events fire before the forLive gate, and
    // `session.status busy` sets the running flag without a settle fetch.
    send("bat-e1", 1, "session.tool.called", { sessionID: sid, assistantMessageID: "m1", id: "t1", name: "read", input: {} });
    send("bat-e2", 2, "session.tool.success", { sessionID: sid, assistantMessageID: "m1", id: "t1", name: "read" });
    send("bat-e3", 3, "session.status", { sessionID: sid, status: { type: "busy" } });
    flushEvents();
    const expected = ["called:read", "raw:session.tool.success", "completed:true", "run.started"].join(",");
    if (got.join(",") !== expected) {
      fail(label, `${got.join(",")} (want ${expected})`, t0);
      return;
    }
    pass(label, `raw + derived ordered (${got.join(" → ")})`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    for (const off of offs) off();
  }
}

async function testStoreFacade(): Promise<void> {
  const t0 = Date.now();
  const label = "store facade: immediate + change-gated subscribe + ctx disposal";
  const values: (string | null)[] = [];
  const len = (): number => values.length;
  let hasActions = false;
  const inst = await activateExtension("bat-facade", {
    activate(ctx: ExtensionContext) {
      hasActions =
        typeof ctx.store.sendPromptTo === "function" &&
        typeof ctx.store.subscribe === "function" &&
        typeof ctx.store.currentSessionID === "function";
      ctx.subscribe((s) => s.pendingWorkspace, (v) => values.push(v));
    },
  });
  try {
    if (!hasActions) {
      fail(label, `ctx.store facade missing the documented surface`, t0);
      return;
    }
    if (len() !== 1) {
      fail(label, `expected an immediate call, got ${len()}`, t0);
      return;
    }
    setPendingWorkspace("w1");
    if (len() !== 2 || values[1] !== "w1") {
      fail(label, `change not delivered: ${JSON.stringify(values)}`, t0);
      return;
    }
    setPendingWorkspace("w1"); // same selected value → no call
    if (len() !== 2) {
      fail(label, `same-value update fired (${len()})`, t0);
      return;
    }
    inst.dispose();
    setPendingWorkspace("w2");
    if (len() !== 2) {
      fail(label, `leaked after dispose: ${JSON.stringify(values)}`, t0);
      return;
    }
    pass(label, `immediate + change-gated (${JSON.stringify(values)}), clean on dispose`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    inst.dispose();
    setPendingWorkspace(null);
  }
}

function testManifestContract(): void {
  const t0 = Date.now();
  const label = "manifest contract: schema parse/resolve + requires check";
  try {
    const parsed = parseManifestContract(
      [
        { key: "on", type: "boolean", title: "On", default: true },
        { key: "n", type: "number", title: "N", default: 5, min: 1, max: 10 },
        { key: "mode", type: "enum", title: "Mode", options: ["a", "b"], default: "a" },
        { key: "bad", type: "wat" },
      ],
      {
        api: 2,
        targets: ["message.timestamp"],
        slots: ["composer.above"],
        services: ["format.timestamp"],
      },
    );
    if (!parsed.settings || parsed.settings.length !== 3 || parsed.problems.length !== 1) {
      fail(
        label,
        `parse: settings=${parsed.settings?.length} problems=${JSON.stringify(parsed.problems)}`,
        t0,
      );
      return;
    }
    // Defaults + clamps + valid overrides; invalid value and unknown key drop.
    const resolved = resolveSettings(parsed.settings, { n: 99, mode: "b", ghost: 1, on: "yes" });
    if (resolved.on !== true || resolved.n !== 10 || resolved.mode !== "b" || "ghost" in resolved) {
      fail(label, `resolve: ${JSON.stringify(resolved)}`, t0);
      return;
    }
    const unmet = checkRequires(parsed.requires, {
      apiVersion: 1,
      hasTarget: (t) => t !== "message.timestamp",
      hasSlot: (s) => s !== "composer.above",
      hasService: () => false,
    });
    if (unmet.length !== 4) {
      fail(label, `checkRequires expected 4 unmet, got ${JSON.stringify(unmet)}`, t0);
      return;
    }
    const satisfied = checkRequires(parsed.requires, {
      apiVersion: 2,
      hasTarget: () => true,
      hasSlot: () => true,
      hasService: () => true,
    });
    if (satisfied.length !== 0) {
      fail(label, `satisfied requires reported ${JSON.stringify(satisfied)}`, t0);
      return;
    }
    pass(label, `3 fields + 1 problem; defaults/clamps/overrides; mismatch→4, match→0`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  }
}

async function testExtensionSettingsStore(): Promise<void> {
  const t0 = Date.now();
  const label = "extension settings: defaults + coerce + ctx.settings disposal";
  const id = "bat-settings";
  try {
    registerExtensionSchema(id, [
      { key: "threshold", type: "number", title: "Threshold", default: 5, min: 1, max: 10 },
      { key: "label", type: "string", title: "Label", default: "hi" },
    ]);
    setExtensionSetting(id, "threshold", 99); // clamps to max
    setExtensionSetting(id, "threshold", "bad"); // invalid → ignored
    const resolved = resolvedExtensionSettings(id);
    if (resolved.threshold !== 10 || resolved.label !== "hi") {
      fail(label, `resolve after set: ${JSON.stringify(resolved)}`, t0);
      return;
    }
    let seen: unknown;
    const inst = await activateExtension(id, {
      activate(ctx: ExtensionContext) {
        ctx.settings.subscribe(() => {
          seen = ctx.settings.get().threshold;
        });
      },
    });
    setExtensionSetting(id, "threshold", 3);
    if (seen !== 3) {
      fail(label, `ctx.settings.subscribe did not fire (${String(seen)})`, t0);
      inst.dispose();
      return;
    }
    inst.dispose();
    setExtensionSetting(id, "threshold", 7);
    if (seen !== 3) {
      fail(label, `settings listener leaked after dispose (${String(seen)})`, t0);
      return;
    }
    extensionSettings(id).reset();
    if (resolvedExtensionSettings(id).threshold !== 5) {
      fail(label, `reset did not restore the default`, t0);
      return;
    }
    pass(label, `clamp(99→10), invalid ignored, subscribe fires + disposes clean`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    extensionSettings(id).reset();
    registerExtensionSchema(id, undefined);
  }
}

function testExtensionDiagnostics(): void {
  const t0 = Date.now();
  const label = "extension diagnostics + known slots";
  try {
    registerKnownSlots(SLOT_IDS);
    if (!isKnownSlot("composer.above") || isKnownSlot("not.a.slot")) {
      fail(
        label,
        `slot registry: composer.above=${isKnownSlot("composer.above")} bogus=${isKnownSlot("not.a.slot")}`,
        t0,
      );
      return;
    }
    setExtensionDiagnostics("bat-diag", ['unmet target "message.timestamp"']);
    const diag = getExtensionDiagnostics("bat-diag");
    if (diag.length !== 1 || !diag[0]!.message.includes("unmet target")) {
      fail(label, `diagnostics not recorded: ${JSON.stringify(diag)}`, t0);
      return;
    }
    clearExtensionDiagnostics("bat-diag");
    if (getExtensionDiagnostics("bat-diag").length !== 0) {
      fail(label, `diagnostics not cleared`, t0);
      return;
    }
    pass(label, `${SLOT_IDS.length} slot ids known; set/clear diagnostics ok`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  }
}

async function testPeerComposition(): Promise<void> {
  const t0 = Date.now();
  const label = "peer composition: collections + extension bus";
  const ids = ["bat-peer-a", "bat-peer-b"];
  const collection = "bat.peer.collection";
  unregisterIds(ids);
  const received: { from: string; payload: unknown }[] = [];
  const instA = await activateExtension("bat-peer-a", {
    activate(ctx: ExtensionContext) {
      ctx.bus.subscribe("bat.peer.channel", (e) =>
        received.push({ from: e.from, payload: e.payload }),
      );
    },
  });
  const instB = await activateExtension("bat-peer-b", {
    activate(ctx: ExtensionContext) {
      ctx.register({
        kind: "contribute",
        id: ids[1]!,
        collection,
        item: { label: "b" },
        order: 20,
      });
      ctx.bus.publish("bat.peer.channel", { hello: "a" });
    },
  });
  try {
    // A contribution from a third registration, ordered before B's.
    register({ kind: "contribute", id: ids[0]!, collection, item: { label: "a" }, order: 10 });
    if (!listCollections().includes(collection)) {
      fail(label, `listCollections() missing ${collection}`, t0);
      return;
    }
    const items = getContributions<{ label: string }>(collection).filter((c) => ids.includes(c.id));
    if (items.length !== 2 || items[0]!.id !== ids[0] || items[1]!.id !== ids[1]) {
      fail(label, `peer items wrong: ${JSON.stringify(items.map((i) => i.id))}`, t0);
      return;
    }
    // B published during activation; A subscribed first, so it heard it.
    if (
      received.length !== 1 ||
      received[0]!.from !== "bat-peer-b" ||
      (received[0]!.payload as { hello?: string }).hello !== "a"
    ) {
      fail(label, `peer bus delivery wrong: ${JSON.stringify(received)}`, t0);
      return;
    }
    instA.dispose();
    publishPeerEvent("bat.peer.channel", { later: true }, "x");
    if (received.length !== 1) {
      fail(label, `peer subscription leaked after dispose (${received.length})`, t0);
      return;
    }
    pass(label, `collection enumerated + ordered; peer event from=bat-peer-b; disposed clean`, t0);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err), t0);
  } finally {
    instA.dispose();
    instB.dispose();
    unregisterIds(ids);
  }
}

function testSlots(): void {
  const t0 = Date.now();
  const label = "slots: contributions render in order + unregister cleanly";
  const slotID = "bat.slot.probe";
  const collection = `slot:${slotID}`;
  const ids = ["bat-slot-lo", "bat-slot-mid", "bat-slot-hi"];
  unregisterIds(ids);
  try {
    // Register out of order; getContributions sorts by `order` (lower first).
    let seenSession: string | null | undefined;
    register({ kind: "contribute", id: ids[0]!, collection, order: 30, item: { render: () => "SLOT_HI" } });
    register({
      kind: "contribute",
      id: ids[1]!,
      collection,
      order: 10,
      item: {
        render: (ctx: { sessionID?: string | null }) => {
          seenSession = ctx.sessionID;
          return "SLOT_LO";
        },
      },
    });
    register({ kind: "contribute", id: ids[2]!, collection, order: 20, item: { render: () => "SLOT_MID" } });

    const html = renderToStaticMarkup(createElement(Slot, { id: slotID, sessionID: "s1" }));
    const pos = ["SLOT_LO", "SLOT_MID", "SLOT_HI"].map((t) => html.indexOf(t));
    const ordered = pos.every((i) => i !== -1) && pos[0]! < pos[1]! && pos[1]! < pos[2]!;
    if (!html.includes(`data-oc-slot="${slotID}"`) || !ordered) {
      fail(label, `markup ${JSON.stringify(html)} (want data-oc-slot + LO<MID<HI)`, t0);
      return;
    }
    if (seenSession !== "s1") {
      fail(label, `sessionID not passed through to render (got ${JSON.stringify(seenSession)})`, t0);
      return;
    }
    // Unregister → the slot collapses to null (no empty wrapper left behind).
    unregisterIds(ids);
    const after = renderToStaticMarkup(createElement(Slot, { id: slotID }));
    if (after !== "") {
      fail(label, `unregister left markup ${JSON.stringify(after)} (want empty)`, t0);
      return;
    }
    pass(label, `slot:${slotID} → LO<MID<HI, data-oc-slot stamped, ctx.sessionID passed; empty after unregister`, t0);
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
  testWrapPropTransform();
  testReplaceFallthrough();
  testContributeAll();
  await testHooks();
  testService();
  testSameIdSwap();
  testUnregisterRestore();
  await testActivationContext();
  await testContextScheduler();
  await testEventBus();
  await testStoreEventIntegration();
  await testStoreFacade();
  testSlots();
  testManifestContract();
  await testExtensionSettingsStore();
  testExtensionDiagnostics();
  await testPeerComposition();

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
