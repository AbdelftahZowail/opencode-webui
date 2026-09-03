#!/usr/bin/env bun
/**
 * DOM-stratum E2E battery (spec §7 — the free layer).
 *
 *   bun scripts/uitest/ext-battery-dom.ts
 *
 * Covers, with no mocks of the unit under test:
 *   K1 foreign() injection + automatic cleanup when React drops the anchor
 *   K2 watch() firing + surviving a session switch (+ silence after dispose)
 *   K3 styles() scoping (data-oc-dom-ext=<id>) + removal on dispose
 *   K4 mount/dispose lifecycle: hot-swap re-mount disposes first, zero ghosts
 *   K5 isDomExtensionModule structural validation table
 *   K6 failed mount() leaves no ghosts (catch path disposes partial work)
 *   A1 data-oc-* anchor contract: every OC_ANCHORS value stamped in src/
 *   P1 dom-only folder (no index.tsx) → manifest entry with domUrl, no url
 *   P2 dom.js serves 200 javascript; unknown dom id → 404
 *   P3 dom.ts hot edit moves the manifest domUrl ?v=
 *
 * K-plus/A-plus run in-process against the REAL src/lib/domKit.ts behind a minimal
 * fake-DOM harness (synchronous MutationObserver fan-out — the harness only
 * replaces the DOM, never domKit). P-plus runs against an ISOLATED proxy
 * (WEBUI_EXTENSION_DIR=/tmp/opencode/bat-dom, WEBUI_PROXY_PORT=4112,
 * WEBUI_SANDBOX=1) so neither the developer's instance (4097) nor the real
 * extension dirs are touched.
 *
 * Test-only file: asserts on src/ + server/ behaviour, modifies neither.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DomExtensionModule } from "../../src/lib/domKit";

// ---------------------------------------------------------------------------
// Fake-DOM harness (replaces the DOM around the real domKit, nothing else)
// ---------------------------------------------------------------------------

type FakeRecord = {
  addedNodes: FakeElement[];
  removedNodes: FakeElement[];
  target: FakeElement | null;
  type: string;
};

function matchesSingle(el: FakeElement, sel: string): boolean {
  if (sel === "*") return true;
  const lb = sel.indexOf("[");
  if (lb === -1) return el.tagName.toLowerCase() === sel.toLowerCase();
  const tag = sel.slice(0, lb).trim();
  const rest = sel.slice(lb).trim();
  if (tag.length > 0 && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  const m = /^\[([^\]=\s]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]$/.exec(rest);
  if (!m) return false;
  const attr = m[1] as string;
  const val = m[2] ?? m[3] ?? m[4];
  if (val === undefined) return el.hasAttribute(attr);
  return el.getAttribute(attr) === val;
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((part) => matchesSingle(el, part));
}

class FakeElement {
  tagName: string;
  parentNode: FakeElement | null = null;
  childNodes: FakeElement[] = [];
  attributes = new Map<string, string>();
  textContent = "";

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get firstChild(): FakeElement | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    const i = sibs.indexOf(this);
    return (i >= 0 ? sibs[i + 1] : undefined) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    if (!this.attributes.has(name)) return null;
    return this.attributes.get(name) as string;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  matches(sel: string): boolean {
    return matchesSelector(this, sel);
  }

  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.childNodes) {
        if (child.matches(sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  contains(other: FakeElement | null): boolean {
    let cur: FakeElement | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  appendChild(child: FakeElement): FakeElement {
    this.insertBefore(child, null);
    return child;
  }

  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    if (child.parentNode) child.parentNode.removeChild(child);
    if (ref === null) {
      this.childNodes.push(child);
    } else {
      const i = this.childNodes.indexOf(ref);
      if (i === -1) this.childNodes.push(child);
      else this.childNodes.splice(i, 0, child);
    }
    child.parentNode = this;
    notifyObservers({ addedNodes: [child], removedNodes: [], target: this });
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const i = this.childNodes.indexOf(child);
    if (i === -1) return child;
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    notifyObservers({ addedNodes: [], removedNodes: [child], target: this });
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

const activeObservers = new Set<FakeMutationObserver>();

class FakeMutationObserver {
  private cb: MutationCallback;

  constructor(cb: MutationCallback) {
    this.cb = cb;
  }

  observe(_target: Node, _options?: MutationObserverInit): void {
    activeObservers.add(this);
  }

  disconnect(): void {
    activeObservers.delete(this);
  }

  __fire(rec: FakeRecord): void {
    this.cb([rec] as unknown as MutationRecord[], this as unknown as MutationObserver);
  }
}

function notifyObservers(rec: Omit<FakeRecord, "type">): void {
  // Like a real MutationObserver on document.body with subtree:true: only
  // mutations inside the observed tree fan out. Detached-subtree edits (e.g.
  // building a node before attaching it) stay silent until attached.
  if (rec.target !== fakeDoc.body && !fakeDoc.body.contains(rec.target)) return;
  const full: FakeRecord = { ...rec, type: "childList" };
  for (const obs of [...activeObservers]) obs.__fire(full);
}

class FakeDocument {
  body = new FakeElement("body");
  head = new FakeElement("head");

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const root of [this.head, this.body]) {
      if (root.matches(sel)) out.push(root);
      out.push(...root.querySelectorAll(sel));
    }
    return out;
  }
}

const fakeDoc = new FakeDocument();
{
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = fakeDoc;
  g.MutationObserver = FakeMutationObserver;
  g.HTMLElement = FakeElement;
  g.Node = FakeElement;
  g.CSS = {
    escape: (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
  };
}

// The REAL unit under test — imported only after the globals above exist.
const { disposeDomExtension, isDomExtensionModule, mountDomExtension, OC_ANCHORS } =
  await import("../../src/lib/domKit");

// ---------------------------------------------------------------------------
// Battery frame
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..", "..");
const BAT_DIR = "/tmp/opencode/bat-dom";
const FIX_ID = "bat-dom-only";
const FIX_DIR = join(BAT_DIR, FIX_ID);
const PROXY_PORT = 4112;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const PROXY_LOG = "/tmp/opencode/bat-dom-proxy.log";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Row {
  label: string;
  status: "PASS" | "FAIL";
  detail?: string;
  secs?: number;
}
const rows: Row[] = [];

function push(label: string, ok: boolean, detail: string, t0: number): void {
  rows.push({ label, status: ok ? "PASS" : "FAIL", detail, secs: Date.now() - t0 });
}

/** Empty <body> between kit tests (observers of disposed ids are already gone). */
function resetBody(): void {
  let child = fakeDoc.body.firstChild;
  while (child) {
    fakeDoc.body.removeChild(child);
    child = fakeDoc.body.firstChild;
  }
}

// ---------------------------------------------------------------------------
// K1 foreign() injection + anchor-removal cleanup
// ---------------------------------------------------------------------------

async function tForeign(): Promise<void> {
  const t0 = Date.now();
  const id = "bat-foreign";
  try {
    resetBody();
    const container = fakeDoc.createElement("div");
    fakeDoc.body.appendChild(container);
    const anchor = fakeDoc.createElement("button");
    anchor.setAttribute("data-oc-composer-send", "");
    container.appendChild(anchor);
    const badge = fakeDoc.createElement("span");
    badge.setAttribute("data-bat-badge", "v1");
    const mod: DomExtensionModule = {
      mount(kit) {
        kit.foreign(anchor as unknown as Element, [badge as unknown as Node]);
      },
    };
    await mountDomExtension(id, mod);
    const injected = anchor.nextSibling === badge && container.contains(badge);
    container.removeChild(anchor); // simulate React dropping the anchor
    const cleaned = badge.parentNode === null && !fakeDoc.body.contains(badge);
    disposeDomExtension(id, mod);
    disposeDomExtension(id, mod); // idempotent second dispose must not throw
    const ok = injected && cleaned;
    push(
      "K1 foreign() injection + anchor-removal cleanup",
      ok,
      `sibling-after-anchor=${injected} auto-removed-with-anchor=${cleaned}`,
      t0,
    );
  } catch (err) {
    push("K1 foreign() injection + anchor-removal cleanup", false, String(err), t0);
  }
}

// ---------------------------------------------------------------------------
// K2 watch() firing + surviving session switch
// ---------------------------------------------------------------------------

async function tWatch(): Promise<void> {
  const t0 = Date.now();
  const id = "bat-watch";
  try {
    resetBody();
    const seen: string[] = [];
    const mod: DomExtensionModule = {
      mount(kit) {
        kit.watch(["[data-oc-composer-send]"], (matched) => {
          for (const el of matched) seen.push(el.getAttribute("data-watch-tag") ?? "?");
        });
      },
    };
    await mountDomExtension(id, mod);
    const b1 = fakeDoc.createElement("button");
    b1.setAttribute("data-oc-composer-send", "");
    b1.setAttribute("data-watch-tag", "s1");
    fakeDoc.body.appendChild(b1);
    const fired1 = seen.includes("s1");

    // Session switch: React replaces the transcript subtree wholesale.
    resetBody();
    const wrap = fakeDoc.createElement("div");
    wrap.setAttribute("data-oc-transcript", "");
    fakeDoc.body.appendChild(wrap);
    const inner = fakeDoc.createElement("div");
    const b2 = fakeDoc.createElement("button");
    b2.setAttribute("data-oc-composer-send", "");
    b2.setAttribute("data-watch-tag", "s2");
    inner.appendChild(b2);
    wrap.appendChild(inner); // nested add → exercises the querySelectorAll branch
    const fired2 = seen.includes("s2");

    disposeDomExtension(id, mod);
    const b3 = fakeDoc.createElement("button");
    b3.setAttribute("data-oc-composer-send", "");
    b3.setAttribute("data-watch-tag", "s3");
    fakeDoc.body.appendChild(b3);
    const stopped = !seen.includes("s3");
    const ok = fired1 && fired2 && stopped;
    push(
      "K2 watch() firing + surviving session switch",
      ok,
      `first-fire=${fired1} post-switch-fire=${fired2} silent-after-dispose=${stopped} (seen=${seen.join(",")})`,
      t0,
    );
  } catch (err) {
    push("K2 watch() firing + surviving session switch", false, String(err), t0);
  }
}

// ---------------------------------------------------------------------------
// K3 styles() scoping + removal on dispose
// ---------------------------------------------------------------------------

async function tStyles(): Promise<void> {
  const t0 = Date.now();
  const id = "bat-styles";
  try {
    resetBody();
    const css = `[data-bat-scoped]{color:red}`;
    const mod: DomExtensionModule = {
      mount(kit) {
        kit.styles(css);
      },
    };
    await mountDomExtension(id, mod);
    const found = fakeDoc.head.querySelectorAll(`[data-oc-dom-ext="${id}"]`);
    const first = found[0];
    const scoped =
      found.length === 1 &&
      first?.getAttribute("data-oc-dom-ext") === id &&
      (first?.textContent ?? "").includes("color:red");
    const visibleFromDocument = fakeDoc.querySelectorAll(`[data-oc-dom-ext="${id}"]`).length === 1;
    disposeDomExtension(id, mod);
    const gone =
      fakeDoc.querySelectorAll(`[data-oc-dom-ext="${id}"]`).length === 0 &&
      fakeDoc.head.querySelectorAll(`[data-oc-dom-ext="${id}"]`).length === 0;
    const ok = scoped && visibleFromDocument && gone;
    push(
      "K3 styles() scoping + removal on dispose",
      ok,
      `scoped-style-present=${scoped} document-visible=${visibleFromDocument} removed-on-dispose=${gone}`,
      t0,
    );
  } catch (err) {
    push("K3 styles() scoping + removal on dispose", false, String(err), t0);
  }
}

// ---------------------------------------------------------------------------
// K4 mount/dispose lifecycle — hot-swap with zero ghosts
// ---------------------------------------------------------------------------

async function tHotSwap(): Promise<void> {
  const t0 = Date.now();
  const id = "bat-swap";
  try {
    resetBody();
    const container = fakeDoc.createElement("div");
    fakeDoc.body.appendChild(container);
    const anchor = fakeDoc.createElement("button");
    anchor.setAttribute("data-oc-composer-send", "");
    container.appendChild(anchor);
    let v1MountCleanup = false;
    let v2Disposed = false;
    const badge1 = fakeDoc.createElement("span");
    badge1.setAttribute("data-bat-swap", "v1");
    const badge2 = fakeDoc.createElement("span");
    badge2.setAttribute("data-bat-swap", "v2");
    const v1: DomExtensionModule = {
      mount(kit) {
        kit.styles(`[data-bat-swap="v1"]{opacity:.5}`);
        kit.foreign(anchor as unknown as Element, [badge1 as unknown as Node]);
        return () => {
          v1MountCleanup = true;
        };
      },
    };
    await mountDomExtension(id, v1);
    const v2: DomExtensionModule = {
      mount(kit) {
        kit.styles(`[data-bat-swap="v2"]{opacity:.9}`);
        kit.foreign(anchor as unknown as Element, [badge2 as unknown as Node]);
      },
      dispose() {
        v2Disposed = true;
      },
    };
    await mountDomExtension(id, v2); // hot-swap: must dispose v1 first
    const styleCount = fakeDoc.querySelectorAll(`[data-oc-dom-ext="${id}"]`).length;
    const badges = fakeDoc.querySelectorAll("[data-bat-swap]");
    const ghostFree =
      v1MountCleanup &&
      badge1.parentNode === null &&
      badge2.parentNode !== null &&
      styleCount === 1 &&
      badges.length === 1 &&
      badges[0]?.getAttribute("data-bat-swap") === "v2";
    disposeDomExtension(id, v2);
    const settled =
      fakeDoc.querySelectorAll(`[data-oc-dom-ext="${id}"]`).length === 0 &&
      fakeDoc.querySelectorAll("[data-bat-swap]").length === 0 &&
      v2Disposed;
    const ok = ghostFree && settled;
    push(
      "K4 mount/dispose lifecycle with zero ghosts on hot-swap",
      ok,
      `v1-cleanup-ran=${v1MountCleanup} old-badge-gone=${badge1.parentNode === null} styles=${styleCount} badges=${badges.length} dispose-ran=${v2Disposed} settled=${settled}`,
      t0,
    );
  } catch (err) {
    push("K4 mount/dispose lifecycle with zero ghosts on hot-swap", false, String(err), t0);
  }
}

// ---------------------------------------------------------------------------
// K5 isDomExtensionModule validation table
// ---------------------------------------------------------------------------

function tValidation(): void {
  const t0 = Date.now();
  try {
    const cases: Array<{ name: string; value: unknown; want: boolean }> = [
      { name: "null", value: null, want: false },
      { name: "undefined", value: undefined, want: false },
      { name: "number", value: 42, want: false },
      { name: "string", value: "dom.ts", want: false },
      { name: "empty-object", value: {}, want: false },
      { name: "mount-string", value: { mount: "x" }, want: false },
      { name: "dispose-only", value: { dispose: () => undefined }, want: false },
      { name: "mount-fn", value: { mount: () => undefined }, want: true },
      {
        name: "mount+dispose",
        value: {
          mount: () => undefined,
          dispose: () => undefined,
        },
        want: true,
      },
      {
        name: "async-mount",
        value: {
          mount: async () => undefined,
        },
        want: true,
      },
    ];
    const bad: string[] = [];
    for (const c of cases) {
      if (isDomExtensionModule(c.value) !== c.want) bad.push(c.name);
    }
    push(
      "K5 isDomExtensionModule validation",
      bad.length === 0,
      bad.length === 0 ? `${cases.length}/${cases.length} cases` : `mismatched: ${bad.join(",")}`,
      t0,
    );
  } catch (err) {
    push("K5 isDomExtensionModule validation", false, String(err), t0);
  }
}

// ---------------------------------------------------------------------------
// K6 failed mount() leaves no ghosts
// ---------------------------------------------------------------------------

async function tFailedMount(): Promise<void> {
  const t0 = Date.now();
  const id = "bat-boom";
  const origError = console.error;
  console.error = () => undefined;
  try {
    resetBody();
    const mod: DomExtensionModule = {
      mount(kit) {
        kit.styles(`[data-bat-boom]{display:none}`);
        throw new Error("boom");
      },
    };
    await mountDomExtension(id, mod);
    const leftovers = fakeDoc.querySelectorAll(`[data-oc-dom-ext="${id}"]`).length;
    push(
      "K6 failed mount() leaves no ghosts",
      leftovers === 0,
      `styles-remaining=${leftovers} (mount threw, catch path must dispose partial work)`,
      t0,
    );
  } catch (err) {
    push("K6 failed mount() leaves no ghosts", false, String(err), t0);
  } finally {
    console.error = origError;
  }
}

// ---------------------------------------------------------------------------
// A1 data-oc-* anchor contract
// ---------------------------------------------------------------------------

function tAnchors(): void {
  const t0 = Date.now();
  try {
    const values = Object.values(OC_ANCHORS);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(entry.name)) files.push(full);
      }
    };
    walk(join(ROOT, "src"));
    const contents = files.map((f) => readFileSync(f, "utf8"));
    const missing: string[] = [];
    let hitFiles = 0;
    for (const anchor of values) {
      const hits = contents.filter((c) => c.includes(anchor)).length;
      if (hits === 0) missing.push(anchor);
      else hitFiles += 1;
    }
    push(
      "A1 data-oc-* anchor contract (OC_ANCHORS ⊆ core markup)",
      missing.length === 0,
      missing.length === 0
        ? `${values.length}/${values.length} anchors stamped (${files.length} src files scanned)`
        : `dropped by restyle: ${missing.join(", ")} (${hitFiles}/${values.length} present)`,
      t0,
    );
  } catch (err) {
    push("A1 data-oc-* anchor contract (OC_ANCHORS ⊆ core markup)", false, String(err), t0);
  }
}

// ---------------------------------------------------------------------------
// Proxy harness (P1–P3)
// ---------------------------------------------------------------------------

interface ManifestEntry {
  id?: string;
  url?: string;
  domUrl?: string;
  disabled?: boolean;
  source?: string;
}

async function fetchManifest(): Promise<ManifestEntry[]> {
  const res = await fetch(`${BASE}/api/webui/extensions`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const body = (await res.json()) as { data?: ManifestEntry[] };
  return Array.isArray(body.data) ? body.data : [];
}

function domFixture(version: "v1" | "v2"): string {
  const probe = version === "v1" ? "__batDomProbeV1" : "__batDomProbeV2";
  return `// bat-dom-only ${version} — DOM-stratum battery fixture (no index.tsx on purpose).
export default {
  mount() {
    (globalThis as unknown as Record<string, unknown>).${probe} = ${version === "v1" ? 1 : 2};
  },
};
`;
}

function writeFixture(version: "v1" | "v2"): void {
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(
    join(FIX_DIR, "manifest.json"),
    JSON.stringify(
      {
        id: FIX_ID,
        name: "BAT DOM only",
        version: "1.0.0",
        description: "DOM-stratum battery fixture (dom-only, no index.tsx)",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(FIX_DIR, "dom.ts"), domFixture(version));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitProxyReady(timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  let last = "no response";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/webui/extensions`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 80) : String(err);
    }
    await sleep(400);
  }
  throw new Error(`proxy not ready after ${timeoutMs}ms (last: ${last})`);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function report(): void {
  const width = Math.max(...rows.map((r) => r.label.length), 30);
  console.log("\n=== DOM stratum battery ===");
  for (const r of rows) {
    const secs = r.secs !== undefined ? ` (${(r.secs / 1000).toFixed(1)}s)` : "";
    console.log(`${r.status.padEnd(4)} ${r.label.padEnd(width)}${secs}`);
    if (r.detail) {
      for (const line of r.detail.split("\n")) console.log(`     ${line}`);
    }
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  console.log(`\nRESULT: ${pass} pass · ${fail} fail → exit ${fail > 0 ? 1 : 0}`);
}

let proxyProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let proxyLog = "";

async function cleanup(): Promise<void> {
  if (proxyProc) {
    const pid = proxyProc.pid;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && pidAlive(pid)) await sleep(150);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    proxyProc = null;
  }
  try {
    rmSync(BAT_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

async function main(): Promise<void> {
  // Kit + contract phases need no proxy.
  await tForeign();
  await tWatch();
  await tStyles();
  await tHotSwap();
  tValidation();
  await tFailedMount();
  tAnchors();

  // Live proxy phases: isolated scratch dir + own port, sandbox (no password).
  rmSync(BAT_DIR, { recursive: true, force: true });
  writeFixture("v1");
  proxyProc = Bun.spawn(["bun", "server/index.ts"], {
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
  const pump = async (s: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (!s) return;
    const reader = s.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) proxyLog += new TextDecoder().decode(value);
      }
    } catch {
      /* torn down with the child */
    }
  };
  void pump(proxyProc.stdout);
  void pump(proxyProc.stderr);

  // P1: dom-only manifest entry.
  {
    const t0 = Date.now();
    try {
      await waitProxyReady(30_000);
      const entries = await fetchManifest();
      const hit = entries.find((e) => e.id === FIX_ID);
      const hasDomUrl =
        !!hit && typeof hit.domUrl === "string" && hit.domUrl.includes("/dom.js?v=");
      const noUrl = !!hit && hit.url === undefined;
      const enabled = !!hit && hit.disabled !== true;
      const ok = hasDomUrl && noUrl && enabled;
      push(
        "P1 dom-only folder → manifest (domUrl, no url)",
        ok,
        ok
          ? `id "${FIX_ID}" domUrl="${hit?.domUrl}" url=∅`
          : `entry=${JSON.stringify(hit ?? null).slice(0, 300)} (want domUrl */dom.js?v=*, no url)`,
        t0,
      );
    } catch (err) {
      push("P1 dom-only folder → manifest (domUrl, no url)", false, String(err), t0);
    }
  }

  // P2: dom.js serves; unknown dom id 404s.
  {
    const t0 = Date.now();
    try {
      const entries = await fetchManifest();
      const hit = entries.find((e) => e.id === FIX_ID);
      if (!hit?.domUrl) throw new Error("no domUrl from P1 — cannot fetch bundle");
      const res = await fetch(`${BASE}${hit.domUrl}`, {
        signal: AbortSignal.timeout(10_000),
      });
      const js = await res.text();
      const serves =
        res.status === 200 &&
        (res.headers.get("content-type") ?? "").includes("javascript") &&
        js.includes("__batDomProbeV1");
      const miss = await fetch(`${BASE}/api/webui/extensions/zz-no-dom-here/dom.js`, {
        signal: AbortSignal.timeout(10_000),
      });
      const ok = serves && miss.status === 404;
      push(
        "P2 dom.js serves 200 javascript; unknown dom id → 404",
        ok,
        `dom.js=${res.status}/${js.length}b probe=${js.includes("__batDomProbeV1")} unknown=${miss.status}`,
        t0,
      );
    } catch (err) {
      push("P2 dom.js serves 200 javascript; unknown dom id → 404", false, String(err), t0);
    }
  }

  // P3: dom.ts hot edit moves ?v=.
  {
    const t0 = Date.now();
    try {
      const before = (await fetchManifest()).find((e) => e.id === FIX_ID)?.domUrl ?? null;
      if (!before) throw new Error("no domUrl baseline — cannot measure ?v= move");
      await sleep(150); // mtimeMs resolution: don't rewrite inside the same tick
      writeFixture("v2");
      let after: string | null = null;
      const t1 = Date.now();
      while (Date.now() - t1 < 25_000) {
        const cur = (await fetchManifest()).find((e) => e.id === FIX_ID)?.domUrl ?? null;
        if (cur && cur !== before) {
          after = cur;
          break;
        }
        await sleep(500);
      }
      const moved = after !== null;
      let servesV2 = false;
      if (after) {
        const res = await fetch(`${BASE}${after}`, {
          signal: AbortSignal.timeout(10_000),
        });
        servesV2 = res.status === 200 && (await res.text()).includes("__batDomProbeV2");
      }
      const ok = moved && servesV2;
      push(
        "P3 dom.ts hot edit moves ?v=",
        ok,
        ok ? `${before} → ${after} (+ serves v2 bundle)` : `before=${before} after=${after} servesV2=${servesV2}`,
        t0,
      );
    } catch (err) {
      push("P3 dom.ts hot edit moves ?v=", false, String(err), t0);
    }
  }
}

let code = 0;
try {
  await main();
} catch (err) {
  rows.push({
    label: "SETUP (fatal)",
    status: "FAIL",
    detail: (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 2_000),
  });
  code = 1;
} finally {
  await cleanup();
  if (proxyLog.trim().length > 0) {
    try {
      mkdirSync("/tmp/opencode", { recursive: true });
      writeFileSync(PROXY_LOG, proxyLog.slice(-24_000));
    } catch {
      /* best effort */
    }
  }
  report();
}
await sleep(50);
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : code);
