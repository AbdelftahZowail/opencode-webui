#!/usr/bin/env bun
/**
 * Session "new" badge contract check — the unread rule, the first-run
 * baseline, and cross-tab propagation.
 *
 *   bun run check:unseen
 *
 * Cross-tab is tested for REAL, not mocked: two independent module instances
 * (`?tab=a` / `?tab=b`) share one stubbed localStorage and talk over a real
 * BroadcastChannel, which is exactly what two browser tabs do. So "opened in
 * one tab clears it in all of them" is proven end to end, not asserted.
 *
 * Test-only file: imports src/lib/sessionActivity.ts and stubs browser
 * globals. Modifies neither src/ nor server/.
 */

// ---------------------------------------------------------------------------
// browser globals — installed BEFORE the module under test is imported
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

/**
 * `window` doubles as the `storage` event target, exactly like a browser tab.
 * The module listens on `window`, so the stub MUST be the same object the
 * events are dispatched on — otherwise the fallback path never runs.
 */
const windowStub = new EventTarget() as unknown as Window & typeof globalThis;

/** localStorage + the `storage` event other tabs receive on write. */
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
    // Real browsers fire this in every OTHER same-origin tab.
    windowStub.dispatchEvent(new StorageEventPolyfill("storage", { key: k, newValue: v }) as unknown as Event);
  },
  removeItem: (k: string) => store.delete(k),
};

/** Bun has no DOM StorageEvent constructor; the module only reads .key/.newValue. */
class StorageEventPolyfill {
  constructor(
    readonly type: string,
    readonly init: { key?: string | null; newValue?: string | null },
  ) {}
  get key() {
    return this.init.key ?? null;
  }
  get newValue() {
    return this.init.newValue ?? null;
  }
}

(globalThis as Record<string, unknown>).window = windowStub;
(globalThis as Record<string, unknown>).localStorage = localStorageStub;

// ---------------------------------------------------------------------------
// tiny check harness (mirrors the other scripts/uitest/* checkers)
// ---------------------------------------------------------------------------

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

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// 1. the unread rule is engine-driven, so it does not depend on polling
// ---------------------------------------------------------------------------

{
  const tab = await import(`../../src/lib/sessionActivity.ts?tab=rule-${Date.now()}`);

  // Baseline: everything that already exists counts as read.
  tab.baselineOpened(["s-old", "s-read"]);
  check(
    "baseline marks the existing list as read (no day-one badge flood)",
    !tab.isSessionUnseen("s-old", Date.now()) && !tab.isSessionUnseen("s-read", Date.now() - HOUR),
  );

  // Output that lands after the baseline is what badges. `justAfter` is nudged
  // past the settle slop: a write landing milliseconds after the baseline sits
  // inside that window and is deliberately NOT badged (no visible churn at boot).
  const justAfter = Date.now() + 5_000;
  check("output newer than the last open reads as unseen", tab.isSessionUnseen("s-old", justAfter));

  // The real transition, with production-shaped timestamps: a run finished,
  // the user had not opened it (unread), then they opened it (read).
  const ranAt = Date.now() - 10_000;
  check("a run nobody opened reads as unseen", tab.isSessionUnseen("s-untouched", ranAt));
  tab.markSessionOpened("s-untouched");
  check("opening the session clears its unseen state", !tab.isSessionUnseen("s-untouched", ranAt));

  // Output older than the last open stays read.
  check(
    "output older than the last open stays read",
    !tab.isSessionUnseen("s-read", Date.now() - 2 * HOUR),
  );

  // The old failure mode: a session nobody ever observed running. The rule is
  // a pure comparison, so it badges identically in a tab that was never open.
  check(
    "unseen does not require having observed the run (tab-independent)",
    tab.isSessionUnseen("s-cold", ranAt),
  );

  // A run you watched start to finish must never badge afterwards: the store
  // stamps `opened` when the run goes idle, and the session list can report a
  // `updated` a beat LATER than that. The slop has to absorb that window.
  tab.markSessionOpened("s-slop");
  check(
    "settle slop absorbs a late session-list refresh",
    !tab.isSessionUnseen("s-slop", Date.now() - 500),
  );

  // Regression: the stamp throttle must stay UNDER the settle slop. It used to
  // be 4s against a 2s slop, so a run finishing 2-4s after you focused the
  // session had its read stamp DISCARDED (the throttle dropped the newer
  // stamp) and then badged anyway — the exact case this rule exists to
  // prevent.
//
// The gap MUST land between the slop and the old throttle (>2s and <4s):
  // a shorter gap is absorbed by SETTLE_SLOP_MS on its own and would pass
  // with the bug present, making this guard vacuous. Verified both ways —
  // this check FAILS at STAMP_THROTTLE_MS = 4_000 and passes at 1_000.
  tab.markSessionOpened("s-watched-run");
  await new Promise((r) => setTimeout(r, 2_500));
  // The run the user watched go idle 2.5s later: this is the store's second
  // `markSessionOpened` for the same session, and it must NOT be throttled
  // away into a badge.
  tab.markSessionOpened("s-watched-run");
  check(
    "a watched run ending 2.5s after focus stays read (throttle < slop)",
    !tab.isSessionUnseen("s-watched-run", Date.now()),
  );

  // Ancient sessions stop nagging.
  check("output older than the TTL stops badging", !tab.isSessionUnseen("s-cold", Date.now() - 8 * DAY));

  // Degenerate inputs must not throw or badge.
  check(
    "empty id / zero timestamp are never unseen",
    !tab.isSessionUnseen("", Date.now()) && !tab.isSessionUnseen("s-cold", 0),
  );

  // Subscribers fire so React can repaint.
  let ticks = 0;
  const off = tab.subscribeActivity(() => ticks++);
  tab.markSessionOpened("s-tick");
  check("subscribers are notified on a read stamp", ticks > 0, `ticks=${ticks}`);
  off();
  const afterOff = ticks;
  tab.markSessionOpened("s-tick2");
  // Must compare to the count BEFORE the second stamp: `ticks > 0` passed
  // whether or not unsubscribe worked, because the first stamp already
  // ticked the counter.
  check("unsubscribing stops notifications", ticks === afterOff, `ticks=${ticks} (unchanged from ${afterOff})`);
}

// ---------------------------------------------------------------------------
// 2. cross-tab: opened in one tab clears it in ALL of them, no refresh
// ---------------------------------------------------------------------------

{
  // Two independent module instances == two tabs: separate in-memory caches,
  // one shared localStorage, one real BroadcastChannel between them.
  const stamp = Date.now();
  const tabA = await import(`../../src/lib/sessionActivity.ts?tab=a-${stamp}`);
  const tabB = await import(`../../src/lib/sessionActivity.ts?tab=b-${stamp}`);

  tabA.baselineOpened(["s-x"]);
  tabB.baselineOpened(["s-x"]);

  const runEnded = Date.now();
  check("both tabs agree the session is unseen", tabA.isSessionUnseen("s-x", runEnded) && tabB.isSessionUnseen("s-x", runEnded));

  // Tab B's React tree is subscribed; tab A does the reading.
  let repaints = 0;
  tabB.subscribeActivity(() => repaints++);

  tabA.markSessionOpened("s-x");

  // BroadcastChannel delivery is async (a macrotask) — give it a turn.
  await new Promise((r) => setTimeout(r, 50));

  check("tab A cleared it locally", !tabA.isSessionUnseen("s-x", runEnded));
  check("tab B cleared it with NO refresh", !tabB.isSessionUnseen("s-x", runEnded));
  check("tab B's subscribers repainted", repaints > 0, `repaints=${repaints}`);

  // The reverse direction must work too (broadcast is symmetric): a read
  // recorded in tab B has to reach tab A's memory and repaint it.
  const longAgo = Date.now() - 2 * HOUR;
  let repaintsA = 0;
  tabA.subscribeActivity(() => repaintsA++);
  tabB.markSessionOpened("s-y");
  await new Promise((r) => setTimeout(r, 50));
  check(
    "read state propagates B → A as well",
    repaintsA > 0 && !tabA.isSessionUnseen("s-y", longAgo),
    `repaintsA=${repaintsA}`,
  );

  // Idempotence: both a BroadcastChannel message AND a storage event arrive
  // for the same write. Merging is max-per-key, so peers must not churn.
  // Uses a FRESH id on purpose — re-stamping `s-y`, which tab B just stamped,
  // is swallowed by STAMP_THROTTLE_MS, so nothing is ever delivered and the
  // assertion would pass without testing idempotence at all.
  let churn = 0;
  tabB.subscribeActivity(() => churn++);
  tabA.markSessionOpened("s-fresh-idempotence");
  await new Promise((r) => setTimeout(r, 50));
  check(
    "a genuinely new read reaches the peer",
    churn > 0,
    `churn=${churn} (delivered)`,
  );
  const churnAfterFirst = churn;
  tabA.markSessionOpened("s-fresh-idempotence"); // re-delivered, must be a no-op
  await new Promise((r) => setTimeout(r, 50));
  check(
    "duplicate delivery is a no-op (no render churn)",
    churn === churnAfterFirst,
    `churn=${churn} (unchanged from ${churnAfterFirst})`,
  );

  // A stale peer must never clobber a newer read with an older stamp.
  const stale = await import(`../../src/lib/sessionActivity.ts?tab=c-${stamp}`);
  stale.baselineOpened([]);
  await new Promise((r) => setTimeout(r, 20));
  check("a fresh tab inherits existing read state from storage", !stale.isSessionUnseen("s-x", runEnded));
}

// ---------------------------------------------------------------------------
// 3. re-baselining is a one-shot (it must not silence future badges)
// ---------------------------------------------------------------------------

{
  const tab = await import(`../../src/lib/sessionActivity.ts?tab=base-${Date.now()}`);
  tab.baselineOpened(["s-1"]);
  tab.baselineOpened(["s-1", "s-2"]);
  const now = Date.now();
  // s-2 was added by the second (no-op) baseline call — it must NOT be
  // silently marked read, or a brand-new session would never badge.
  check("baseline only ever runs once", tab.isSessionUnseen("s-2", now));
  check("and still clears on open", (() => {
    tab.markSessionOpened("s-2");
    return !tab.isSessionUnseen("s-2", now);
  })());
}

console.log(`\nRESULT: ${passed} pass · ${failed} fail`);
// Explicit exit: the tab instances hold open BroadcastChannels, which keep
// the event loop alive after the last assertion.
process.exit(failed > 0 ? 1 : 0);
