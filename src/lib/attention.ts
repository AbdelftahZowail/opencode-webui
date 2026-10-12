/**
 * Attention / notifications (parity plan §5 R5).
 *
 * On an attention-worthy event — a finished turn, a run error, a permission
 * request, or a form/question — this raises an OS notification (by default
 * only while the tab is hidden, the web analogue of the TUI's "blurred") and
 * plays a short synthesized cue. Every event is de-duplicated by id.
 *
 * Design constraints (see the R5 brief):
 *  - **Importable without side effects.** The module body only declares
 *    state; nothing listens, and no `AudioContext` is created, until
 *    `startAttention()` runs.
 *  - **No sounds on disk.** Cues are synthesized with WebAudio (there is no
 *    audio-asset dependency); `sound_pack` is accepted for config-shape
 *    compatibility but the single built-in synth pack is always used.
 *  - **Off by default.** `attention.enabled` defaults to `false` — v2's own
 *    precedent. Nothing fires until the user turns it on.
 *  - **No storm on reload.** Raw engine events replayed on an SSE reconnect
 *    are filtered (stale `created`) and every id is remembered, so a reload
 *    never replays a burst of notifications. The derived `run.ended` has no
 *    engine timestamp, so a short settle window after start covers it.
 *
 * The config lives under `prefs.attention` (see `src/prefs.ts`); this module
 * reads it live on every event, so flipping it off silences immediately.
 */

import { getState, sessionHref } from "../store";
import { subscribeEvents, type BusEvent } from "./eventBus";
import { ensureMcpStatus, getMcpStatus, subscribeMcpStatus } from "./mcpStatus";
import { notify } from "./notify";
import { getPrefs, setPref, subscribePrefs } from "../prefs";

// ---- config ---------------------------------------------------------------

/** The four attention-worthy event families. */
export type AttentionKind = "turn" | "error" | "permission" | "form";

/** A synthesized cue preset. One per kind by default (see `sounds`). */
export type AttentionSoundName = AttentionKind;

/**
 * `attention` config shape (parity §5 R5):
 *   - `enabled`       master switch (default **false**)
 *   - `notifications` show OS notifications
 *   - `sound`         play a cue
 *   - `volume`        0..1
 *   - `sound_pack?`   accepted for shape parity; ignored (synth only)
 *   - `sounds?`       per-kind cue override (kind → preset)
 */
export interface AttentionConfig {
  enabled: boolean;
  notifications: boolean;
  sound: boolean;
  volume: number;
  sound_pack?: string;
  sounds?: Partial<Record<AttentionKind, AttentionSoundName>>;
}

export const ATTENTION_KINDS: readonly AttentionKind[] = ["turn", "error", "permission", "form"];

export const ATTENTION_DEFAULTS: AttentionConfig = {
  enabled: false,
  notifications: true,
  sound: true,
  volume: 0.6,
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function normalizeSounds(raw: unknown): Partial<Record<AttentionKind, AttentionSoundName>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Partial<Record<AttentionKind, AttentionSoundName>> = {};
  for (const k of ATTENTION_KINDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && (ATTENTION_KINDS as readonly string[]).includes(v)) {
      out[k] = v as AttentionSoundName;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Coerce arbitrary stored JSON into a valid config, filling every default. */
export function normalizeAttentionConfig(raw: unknown): AttentionConfig {
  const r = (raw ?? {}) as Partial<AttentionConfig>;
  return {
    enabled: r.enabled === true,
    notifications: r.notifications !== false,
    sound: r.sound !== false,
    volume:
      typeof r.volume === "number" && Number.isFinite(r.volume)
        ? clamp01(r.volume)
        : ATTENTION_DEFAULTS.volume,
    sound_pack: typeof r.sound_pack === "string" && r.sound_pack ? r.sound_pack : undefined,
    sounds: normalizeSounds(r.sounds),
  };
}

// The config is hosted by the ONE prefs store. Until `prefs.ts` declares the
// `attention` key (Wave-2 change) this reads/writes it through a widened view;
// the value round-trips through `localStorage` either way.
type PrefsWithAttention = ReturnType<typeof getPrefs> & { attention?: unknown };

/** The current attention config (defaults applied). */
export function attentionConfig(): AttentionConfig {
  return normalizeAttentionConfig((getPrefs() as PrefsWithAttention).attention);
}

/** Repaint on config changes (fires for every prefs change — cheap). */
export function subscribeAttention(fn: () => void): () => void {
  return subscribePrefs(fn);
}

/** Merge a config patch and persist it under `prefs.attention`. */
export function setAttentionConfig(patch: Partial<AttentionConfig>): void {
  const next = normalizeAttentionConfig({ ...attentionConfig(), ...patch });
  (setPref as unknown as (key: string, value: unknown) => void)("attention", next);
}

// ---- pure helpers ---------------------------------------------------------

/**
 * Whether an OS notification should be raised. Pure.
 *
 * `enabled` is the *notification* gate (master `enabled && notifications`);
 * subagent sessions never notify (they still play a cue).
 */
export function shouldNotify(opts: {
  enabled: boolean;
  hidden: boolean;
  isSubagent: boolean;
}): boolean {
  return opts.enabled && opts.hidden && !opts.isSubagent;
}

/**
 * The stable de-dupe identity for an attention event, or `null` when the event
 * is not attention-worthy (or has no id to de-dupe on). Pure.
 */
export function dedupeKey(event: BusEvent): string | null {
  const sid = event.sessionID ?? "";
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.name) {
    case "permission.asked": {
      const id = typeof p.id === "string" ? p.id : undefined;
      return id ? `permission:${id}` : null;
    }
    case "form.created": {
      const form = p.form as { id?: unknown } | undefined;
      const id = form && typeof form.id === "string" ? form.id : undefined;
      return id ? `form:${id}` : null;
    }
    case "session.error":
    case "session.execution.failed":
      return sid ? `error:${sid}` : null;
    case "run.ended": {
      const reason = typeof p.reason === "string" ? p.reason : "idle";
      if (reason === "session.execution.interrupted") return null;
      if (reason === "session.execution.failed") return sid ? `error:${sid}` : null;
      return sid ? `run-end:${sid}:${reason}` : null;
    }
    default:
      return null;
  }
}

/** Classify an event into an attention kind, or `null` when it is ignored. Pure. */
export function attentionKind(event: BusEvent): AttentionKind | null {
  switch (event.name) {
    case "permission.asked":
      return "permission";
    case "form.created":
      return "form";
    case "session.error":
    case "session.execution.failed":
      return "error";
    case "run.ended": {
      const reason =
        ((event.payload ?? {}) as { reason?: string }).reason ?? "idle";
      if (reason === "session.execution.interrupted") return null;
      return reason === "session.execution.failed" ? "error" : "turn";
    }
    default:
      return null;
  }
}

/** The cue preset for a kind (honoring a `sounds` override). */
export function attentionSoundFor(
  kind: AttentionKind,
  cfg: AttentionConfig = attentionConfig(),
): AttentionSoundName {
  return cfg.sounds?.[kind] ?? kind;
}

// ---- WebAudio synth -------------------------------------------------------

interface Tone {
  freq: number;
  /** Seconds after the cue start. */
  at: number;
  /** Seconds. */
  dur: number;
  type: OscillatorType;
}

/** Deliberately tiny, distinct two-note cues — no assets. */
const SOUND_PRESETS: Record<AttentionSoundName, Tone[]> = {
  turn: [
    { freq: 660, at: 0, dur: 0.11, type: "sine" },
    { freq: 880, at: 0.1, dur: 0.16, type: "sine" },
  ],
  error: [
    { freq: 240, at: 0, dur: 0.16, type: "square" },
    { freq: 175, at: 0.15, dur: 0.24, type: "square" },
  ],
  permission: [
    { freq: 520, at: 0, dur: 0.1, type: "triangle" },
    { freq: 740, at: 0.09, dur: 0.14, type: "triangle" },
  ],
  form: [
    { freq: 600, at: 0, dur: 0.09, type: "sine" },
    { freq: 600, at: 0.13, dur: 0.12, type: "sine" },
  ],
};

let audio: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audio) {
    try {
      audio = new Ctor();
    } catch {
      return null;
    }
  }
  // Autoplay policy: a context created before a gesture starts suspended.
  // Resuming is best-effort; once the user has interacted it is unlocked.
  if (audio.state === "suspended") void audio.resume().catch(() => undefined);
  return audio;
}

/** Play a synthesized cue. No-op when WebAudio is unavailable. */
export function playSound(name: AttentionSoundName = "turn", volume: number = ATTENTION_DEFAULTS.volume): void {
  const vol = clamp01(volume);
  if (vol <= 0) return;
  const ctx = audioContext();
  if (!ctx) return;
  const preset = SOUND_PRESETS[name] ?? SOUND_PRESETS.turn;
  const now = ctx.currentTime;
  for (const tone of preset) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type;
    osc.frequency.value = tone.freq;
    const start = now + tone.at;
    const end = start + tone.dur;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(vol, start + Math.min(0.02, tone.dur / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

// ---- runtime --------------------------------------------------------------

function isHidden(): boolean {
  return typeof document !== "undefined" ? document.hidden : false;
}

function sessionTitle(sessionID?: string): string {
  if (!sessionID) return "Session";
  const s = getState();
  const info = s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID];
  const title = info?.title?.trim();
  return title || "Untitled session";
}

function isSubagentSession(sessionID?: string): boolean {
  if (!sessionID) return false;
  const s = getState();
  const info = s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID];
  return !!info?.parentID;
}

function notificationFor(event: BusEvent, kind: AttentionKind): { title: string; body: string } {
  const who = sessionTitle(event.sessionID);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "permission": {
      const action = typeof p.action === "string" ? p.action : "a tool";
      return { title: `Permission needed — ${who}`, body: `Waiting to run: ${action}` };
    }
    case "form": {
      const form = p.form as { title?: unknown } | undefined;
      const title = form && typeof form.title === "string" ? form.title : "A question needs an answer";
      return { title: `Question — ${who}`, body: title };
    }
    case "error": {
      const err = p.error as { message?: unknown } | undefined;
      const msg = err && typeof err.message === "string" ? err.message : "The run failed.";
      return { title: `Error — ${who}`, body: msg };
    }
    case "turn":
    default:
      return { title: `Finished — ${who}`, body: "The turn finished." };
  }
}

function osNotify(req: { title: string; body: string; key: string; sessionID?: string }): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(req.title, { body: req.body, tag: req.key, silent: true });
    const sid = req.sessionID;
    n.onclick = () => {
      try {
        window.focus();
        if (sid && window.location.pathname !== sessionHref(sid)) {
          window.location.assign(sessionHref(sid));
        }
      } catch {
        /* navigation is best-effort */
      }
    };
  } catch {
    /* some browsers refuse constructed notifications — the cue still plays */
  }
}

// De-dupe memory. Bounded: evicting wholesale is fine because a replayed
// event that matters arrives with an id we still hold in the common case.
const seenKeys = new Set<string>();
const SEEN_MAX = 400;
/** Raw events older than this at start are a reconnect replay, not new work. */
const REPLAY_GRACE_MS = 15_000;
/** Derived `run.ended` has no engine timestamp — ignore the initial drain. */
const SETTLE_MS = 2_000;

let startedAt = 0;

function remember(key: string): void {
  if (seenKeys.size >= SEEN_MAX) seenKeys.clear();
  seenKeys.add(key);
}

/** A fresh run in a session re-arms its turn-end / error notifications. */
function forgetSession(sessionID?: string): void {
  if (!sessionID) return;
  const prefix = `run-end:${sessionID}:`;
  for (const k of [...seenKeys]) {
    if (k.startsWith(prefix)) seenKeys.delete(k);
  }
  seenKeys.delete(`error:${sessionID}`);
}

function isReplay(event: BusEvent): boolean {
  if (event.name === "run.ended") return Date.now() - startedAt < SETTLE_MS;
  if (typeof event.created === "number" && event.created < startedAt - REPLAY_GRACE_MS) {
    return true;
  }
  return false;
}

function handleEvent(event: BusEvent): void {
  const kind = attentionKind(event);
  if (!kind) return;
  const key = dedupeKey(event);
  if (!key) return;
  const cfg = attentionConfig();
  if (!cfg.enabled) return;
  if (isReplay(event)) return;
  if (seenKeys.has(key)) return;
  remember(key);

  const isSubagent = isSubagentSession(event.sessionID);
  // Subagents suppress the notification but still play the cue.
  if (cfg.sound) playSound(attentionSoundFor(kind, cfg), cfg.volume);
  if (shouldNotify({ enabled: cfg.notifications, hidden: isHidden(), isSubagent })) {
    osNotify({ ...notificationFor(event, kind), key, sessionID: event.sessionID });
  }
}

let started = false;
let stopFn: (() => void) | null = null;

/**
 * Start attention. Idempotent; returns a disposer. Importing this module does
 * nothing until this is called.
 *
 * Also watches the global MCP status cache and raises a toast the first time a
 * server *transitions* into `failed` (never on the initial snapshot, so a
 * reload cannot storm). The toast is `notify(...)` — it currently carries no
 * action; see the R5 report for the minimal `notify.ts` enhancement that adds
 * "Open MCP servers".
 */
export function startAttention(): () => void {
  if (started && stopFn) return stopFn;
  started = true;
  startedAt = Date.now();
  seenKeys.clear();

  const offs: Array<() => void> = [];
  offs.push(subscribeEvents("run.started", (e) => forgetSession(e.sessionID)));
  offs.push(subscribeEvents("run.ended", handleEvent));
  offs.push(subscribeEvents("session.error", handleEvent));
  offs.push(subscribeEvents("session.execution.failed", handleEvent));
  offs.push(subscribeEvents("permission.asked", handleEvent));
  offs.push(subscribeEvents("form.created", handleEvent));

  // MCP failures (independent of the attention gate — a broken server is a
  // real error surface). Transition-only, so the first snapshot never toasts.
  ensureMcpStatus();
  let mcpKnown: Map<string, string> | null = null;
  offs.push(
    subscribeMcpStatus(() => {
      const servers = getMcpStatus().servers ?? [];
      if (mcpKnown !== null) {
        for (const s of servers) {
          if (s.status.status === "failed" && mcpKnown.get(s.name) !== "failed") {
            notify({
              title: `MCP server "${s.name}" failed`,
              description: s.status.error,
              variant: "destructive",
            });
          }
        }
      }
      const next = new Map<string, string>();
      for (const s of servers) next.set(s.name, s.status.status);
      mcpKnown = next;
    }),
  );

  const stop = () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* unsubscribe is best-effort */
      }
    }
    started = false;
    stopFn = null;
  };
  stopFn = stop;
  return stop;
}

/** Stop attention (no-op when not started). */
export function stopAttention(): void {
  stopFn?.();
}
