#!/usr/bin/env bun
/**
 * Engine-endpoint guard check — discovery-first, single-flight and the circuit
 * breaker from server/engineResolver.ts.
 *
 * These are the guards that keep "the engine restarted while a browser was
 * open" from becoming a fork storm, so every branch is pinned here. The deps
 * are injected fakes: no engine, no spawned processes, no network.
 *
 * The last case replays the actual incident — an engine that cannot come up
 * while requests keep arriving — and asserts the request count no longer
 * multiplies into process count.
 *
 *   bun run check:engine-guard
 */

import { createEngineResolver, type EngineEndpoint } from "../../server/engineResolver";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ep = (url: string): EngineEndpoint => ({ url });

type HarnessOptions = {
  discover?: () => Promise<EngineEndpoint | undefined>;
  ensure?: () => Promise<EngineEndpoint>;
  resolveOverride?: () => EngineEndpoint | null;
};

/** Fake clock + call counters around a resolver with injected behaviour. */
function harness(opts: HarnessOptions = {}) {
  let clock = 1_000_000;
  const calls = { discover: 0, ensure: 0 };
  const connected: string[] = [];
  const invalidated: string[] = [];
  const backoffs: number[] = [];

  const resolver = createEngineResolver({
    now: () => clock,
    discover: async () => {
      calls.discover++;
      return opts.discover ? await opts.discover() : undefined;
    },
    ensure: async () => {
      calls.ensure++;
      if (!opts.ensure) throw new Error("no ensure configured");
      return await opts.ensure();
    },
    ...(opts.resolveOverride ? { resolveOverride: opts.resolveOverride } : {}),
    onConnected: (url, suffix) => connected.push(`${url}${suffix}`),
    onInvalidated: (reason) => invalidated.push(reason),
    onFailure: ({ backoffMs }) => backoffs.push(backoffMs),
  });

  return {
    resolver,
    calls,
    connected,
    invalidated,
    backoffs,
    advance: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}

// --- discovery-first -------------------------------------------------------
{
  const h = harness({ discover: async () => ep("http://a") });
  const got = await h.resolver.endpoint();
  check("discovery hit adopts without spawning", got.url === "http://a" && h.calls.ensure === 0);
  check("discovery hit announces once", h.connected.length === 1, h.connected.join(","));
  await h.resolver.endpoint();
  check("repeat calls are memoized", h.calls.discover === 1 && h.connected.length === 1);
}

{
  const h = harness({ ensure: async () => ep("http://b") });
  const got = await h.resolver.endpoint();
  check("discovery miss falls through to ensure", got.url === "http://b" && h.calls.ensure === 1);
  check("success leaves the breaker closed", !h.resolver.state().coolingDown);
}

// --- single-flight --------------------------------------------------------
{
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const h = harness({
    ensure: async () => {
      await gate;
      return ep("http://c");
    },
  });
  const all = Promise.all(Array.from({ length: 20 }, () => h.resolver.endpoint()));
  await Bun.sleep(1);
  check("20 concurrent callers share one ensure", h.calls.ensure === 1, `saw ${h.calls.ensure}`);
  release();
  const got = await all;
  check("every concurrent caller gets the endpoint", got.every((e) => e.url === "http://c"));
}

{
  const h = harness({
    ensure: async () => {
      throw new Error("concurrent-boom");
    },
  });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => h.resolver.endpoint()));
  check(
    "concurrent callers all reject on failure",
    results.every((r) => r.status === "rejected") && h.calls.ensure === 1,
    `ensure=${h.calls.ensure}`,
  );
}

// --- circuit breaker ------------------------------------------------------
{
  const h = harness({
    ensure: async () => {
      throw new Error("boom");
    },
  });
  let err: unknown;
  try {
    await h.resolver.endpoint();
  } catch (e) {
    err = e;
  }
  check("failure propagates to the caller", err instanceof Error && err.message === "boom");
  check("failure arms the base backoff", h.backoffs[0] === 5_000, String(h.backoffs[0]));
  check("failure opens the breaker", h.resolver.state().coolingDown);

  const before = h.calls.ensure;
  let fast: unknown;
  try {
    await h.resolver.endpoint();
  } catch (e) {
    fast = e;
  }
  check("cooling down: ensure is not called again", h.calls.ensure === before);
  check(
    "cooling down: caller fails fast with a countdown",
    fast instanceof Error && /^engine unavailable — next start attempt in \d+s/.test(fast.message),
    fast instanceof Error ? fast.message : "",
  );
  check("cooling down: only one failure recorded", h.backoffs.length === 1);
}

{
  const h = harness({
    ensure: async () => {
      throw new Error("boom");
    },
  });
  for (let i = 0; i < 5; i++) {
    await h.resolver.endpoint().catch(() => undefined);
    h.advance(31_000);
  }
  check(
    "backoff doubles then caps at 30s",
    JSON.stringify(h.backoffs) === JSON.stringify([5_000, 10_000, 20_000, 30_000, 30_000]),
    h.backoffs.join(","),
  );
}

{
  let attempt = 0;
  const h = harness({
    ensure: async () => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
      return ep("http://e");
    },
  });
  await h.resolver.endpoint().catch(() => undefined);
  const before = h.calls.ensure;
  h.advance(5_000);
  const got = await h.resolver.endpoint();
  check("expired cooldown retries ensure", h.calls.ensure === before + 1 && got.url === "http://e");
  check("success clears the failure count", h.resolver.state().failures === 0);
}

// --- recovery stays instant, and spawn-free -------------------------------
{
  let down = true;
  const h = harness({
    discover: async () => (down ? undefined : ep("http://d")),
    ensure: async () => {
      throw new Error("boom");
    },
  });
  await h.resolver.endpoint().catch(() => undefined);
  check("engine down: breaker is open", h.resolver.state().coolingDown);
  down = false;
  const got = await h.resolver.endpoint();
  check("engine returns mid-cooldown: discovery adopts it", got.url === "http://d");
  check("recovery never spawned", h.calls.ensure === 1, `saw ${h.calls.ensure}`);
  check("recovery clears the breaker", h.resolver.state().failures === 0);
}

// --- override -------------------------------------------------------------
{
  const h = harness({
    discover: async () => ep("http://other"),
    resolveOverride: () => ep("http://fixed"),
  });
  const got = await h.resolver.endpoint();
  check("override wins", got.url === "http://fixed");
  check("override never discovers or spawns", h.calls.discover === 0 && h.calls.ensure === 0);
  check(
    "override announces its provenance",
    h.connected[0] === "http://fixed (WEBUI_ENGINE_URL)",
    h.connected.join(","),
  );
}

// --- invalidation ---------------------------------------------------------
{
  const h = harness({ discover: async () => ep("http://f") });
  await h.resolver.endpoint();
  h.resolver.invalidate("event recorder dropped");
  check("invalidate is reported", h.invalidated.length === 1);
  const got = await h.resolver.endpoint();
  check("invalidate re-resolves via discovery, never ensure", got.url === "http://f" && h.calls.ensure === 0);

  const idle = harness();
  idle.resolver.invalidate("nothing memoized");
  check("invalidate is a no-op when unconnected", idle.invalidated.length === 0);
}

{
  let phase: "ok" | "down" | "back" = "ok";
  const h = harness({
    discover: async () => (phase === "down" ? undefined : ep("http://i")),
    ensure: async () => {
      throw new Error("boom");
    },
  });
  await h.resolver.endpoint();
  phase = "down";
  h.resolver.invalidate("engine died");
  await h.resolver.endpoint().catch(() => undefined);
  check("recovery is re-announced after a logged failure", h.connected.length === 1);
  phase = "back";
  await h.resolver.endpoint();
  check("a new stretch of health announces again", h.connected.length === 2, h.connected.join(","));
}

// --- the incident, replayed ----------------------------------------------
// Engine cannot come up (its port is held by an unregistered process), and 250
// requests arrive across four minutes of retries. Before the guards, every one
// of those requests reached ensure() — and ensure() spawns a contender every 5s
// for up to 120s without ever killing them.
{
  const h = harness({
    ensure: async () => {
      throw new Error("Managed service port 49374 ... already in use by another process");
    },
  });
  for (let wave = 0; wave < 5; wave++) {
    await Promise.all(Array.from({ length: 50 }, () => h.resolver.endpoint().catch(() => undefined)));
    h.advance(31_000);
  }
  check(
    "storm: 250 requests collapse to 5 bounded ensure calls",
    h.calls.ensure === 5,
    `saw ${h.calls.ensure}`,
  );
  check("storm: discovery is probed on every request (spawn-free)", h.calls.discover === 250);
}

console.log(`\nRESULT: ${passed} pass · ${failed} fail → exit ${failed > 0 ? 1 : 0}`);
process.exit(failed > 0 ? 1 : 0);
