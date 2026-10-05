/**
 * Model memory — what the webui remembers about model choice across page loads.
 *
 * The complaint this solves: a new session opened on the engine's "newest
 * available" answer, ignoring everything the user had ever done. Three keys
 * live under one localStorage entry (the `drafts.ts`/`prefs.ts` pattern: JSON
 * parse with a shape guard, write-through, caps, never throws):
 *
 *   pinned   — the explicit "use this for new sessions" pin (picker footer).
 *   lastUsed — the model committed on the last real send, NOT a mere pick;
 *              a dirty pick that was switched back evaporates by design.
 *   recents  — a small newest-first history derived from `lastUsed`, capped.
 *   notified — one-time notice keys, so an unavailable remembered ref warns
 *              exactly once instead of on every draft open.
 *
 * `resolveNewSessionModel` is the cascade both the picker and the store use:
 *
 *   pinned → lastUsed → engine default → first enabled catalog model
 *
 * validating the remembered halves against the ENABLED catalog, so a removed
 * provider can never be silently resurrected. When a remembered ref is gone, a
 * one-time notice is published (`getNotice`) and the resolver continues to the
 * next step.
 *
 * Scope is global, not per-workspace (the opinion calls per-workspace defaults
 * "a surprise machine"); per-device persistence is a feature, not a bug.
 */

import { api } from "../api/client";
import type { ModelInfo, ModelRef } from "../api/types";
import { ensureModels } from "./modelCatalog";

const STORAGE_KEY = "webui.modelMemory";
/** Newest-first recents history cap (the opinion says 3–5). */
export const MAX_RECENTS = 5;
const MAX_NOTIFIED = 20;

export interface ModelMemoryData {
  pinned: ModelRef | null;
  lastUsed: ModelRef | null;
  recents: ModelRef[];
  notified: string[];
}

/** A remembered ref that no longer resolves, plus what we used instead. */
export interface ModelNotice {
  role: "pinned" | "lastUsed";
  ref: ModelRef;
  fallback: ModelRef | null;
}

const EMPTY: ModelMemoryData = { pinned: null, lastUsed: null, recents: [], notified: [] };

function isRef(value: unknown): value is ModelRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.id === "string" &&
    typeof ref.providerID === "string" &&
    (ref.variant === undefined || typeof ref.variant === "string")
  );
}

/** Persist only the canonical fields (drops anything else JSON carried). */
function cleanRef(ref: ModelRef): ModelRef {
  return ref.variant
    ? { id: ref.id, providerID: ref.providerID, variant: ref.variant }
    : { id: ref.id, providerID: ref.providerID };
}

function load(): ModelMemoryData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<ModelMemoryData>;
    if (!parsed || typeof parsed !== "object") return { ...EMPTY };
    return {
      pinned: isRef(parsed.pinned) ? cleanRef(parsed.pinned) : null,
      lastUsed: isRef(parsed.lastUsed) ? cleanRef(parsed.lastUsed) : null,
      recents: Array.isArray(parsed.recents)
        ? parsed.recents.filter(isRef).map(cleanRef).slice(0, MAX_RECENTS)
        : [],
      notified: Array.isArray(parsed.notified)
        ? parsed.notified.filter((s): s is string => typeof s === "string").slice(-MAX_NOTIFIED)
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function write(data: ModelMemoryData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable (private mode/quota) — memory just doesn't persist */
  }
}

// ---- subscription (memory changes AND notice changes) ---------------------

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const fn of listeners) fn();
}

export function subscribeModelMemory(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Monotonic version — cheap dependency for `useMemo`/effects. */
export function getMemoryVersion(): number {
  return version;
}

// ---- readers --------------------------------------------------------------

export function getPinnedDefault(): ModelRef | null {
  return load().pinned;
}

export function getLastUsed(): ModelRef | null {
  return load().lastUsed;
}

/** Canonical ref identity, ignoring variant. */
export function refKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}`;
}

export function isRefAvailable(models: ModelInfo[], ref: ModelRef): boolean {
  return models.some((m) => m.enabled && m.modelID === ref.id && m.providerID === ref.providerID);
}

/** Recents that still exist in the enabled catalog, newest first, deduped. */
export function getAvailableRecents(models: ModelInfo[]): ModelRef[] {
  const enabled = models.filter((m) => m.enabled);
  const seen = new Set<string>();
  const out: ModelRef[] = [];
  for (const ref of load().recents) {
    const key = refKey(ref);
    if (seen.has(key) || !isRefAvailable(enabled, ref)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// ---- writers --------------------------------------------------------------

/**
 * Set (or clear, with `null`) the explicit default pin. Also drops any notice
 * still on screen — pinning is the notice's remedy, so it is now stale.
 */
export function setPinnedDefault(ref: ModelRef | null): void {
  const mem = load();
  write({ ...mem, pinned: ref ? cleanRef(ref) : null });
  if (notice) notice = null;
  emit();
}

/** Record a COMMITTED send's model: updates `lastUsed` + recents (dedup, cap). */
export function recordModelUsed(ref: ModelRef): void {
  const clean = cleanRef(ref);
  const mem = load();
  const recents = [clean, ...mem.recents.filter((r) => refKey(r) !== refKey(clean))].slice(0, MAX_RECENTS);
  write({ ...mem, lastUsed: clean, recents });
  emit();
}

// ---- one-time notice ------------------------------------------------------

let notice: ModelNotice | null = null;

export function getNotice(): ModelNotice | null {
  return notice;
}

export function clearNotice(): void {
  if (!notice) return;
  notice = null;
  emit();
}

function publishNotice(next: ModelNotice): void {
  const key = `${next.role}:${refKey(next.ref)}`;
  const mem = load();
  if (mem.notified.includes(key)) return; // already warned once
  write({ ...mem, notified: [...mem.notified, key].slice(-MAX_NOTIFIED) });
  notice = next;
  emit();
}

// ---- the cascade ----------------------------------------------------------

/**
 * Resolve the model a NEW session should open on. Validates remembered refs
 * against the enabled catalog; publishes a one-time notice when a remembered
 * ref is unavailable. Pass a warm catalog to skip a fetch.
 */
export async function resolveNewSessionModel(modelsArg?: ModelInfo[]): Promise<ModelRef | undefined> {
  const models = modelsArg ?? (await ensureModels());
  const enabled = models.filter((m) => m.enabled);

  const pinned = getPinnedDefault();
  if (pinned && isRefAvailable(enabled, pinned)) return pinned;

  const pinnedKey = pinned ? refKey(pinned) : null;
  const last = getLastUsed();
  const lastUsable = last && refKey(last) !== pinnedKey && isRefAvailable(enabled, last);
  if (lastUsable) {
    if (pinned) publishNotice({ role: "pinned", ref: pinned, fallback: last });
    return last;
  }

  let engine: ModelRef | undefined;
  try {
    const def = await api.modelDefault();
    if (def) engine = { id: def.modelID, providerID: def.providerID };
  } catch {
    /* fall through to the first enabled model */
  }
  if (engine && isRefAvailable(enabled, engine)) {
    if (pinned) publishNotice({ role: "pinned", ref: pinned, fallback: engine });
    else if (last) publishNotice({ role: "lastUsed", ref: last, fallback: engine });
    return engine;
  }

  const first = enabled[0];
  const fallback = first ? { id: first.modelID, providerID: first.providerID } : undefined;
  if (pinned) publishNotice({ role: "pinned", ref: pinned, fallback: fallback ?? null });
  else if (last) publishNotice({ role: "lastUsed", ref: last, fallback: fallback ?? null });
  return fallback;
}
