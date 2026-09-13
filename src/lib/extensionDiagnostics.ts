/**
 * Extension diagnostics (roadmap item 8) — the visible record of declared
 * contract problems (malformed manifest fields, unmet `requires`), so a broken
 * reference is a warning in Settings › Extensions instead of a blank spot.
 *
 * The browser loader writes per-id diagnostics during each manifest sync;
 * Settings reads them. Kept tiny and dependency-free so both sides can use it
 * without cycles.
 */

export interface ExtensionDiagnostic {
  level: "warn" | "error";
  message: string;
}

const byId = new Map<string, ExtensionDiagnostic[]>();
const listeners = new Set<() => void>();

function same(a: ExtensionDiagnostic[] | undefined, b: ExtensionDiagnostic[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.level !== b[i]!.level || a[i]!.message !== b[i]!.message) return false;
  }
  return true;
}

/** Replace one id's diagnostics (no-op + no notify when unchanged). */
export function setExtensionDiagnostics(id: string, messages: string[]): void {
  const next: ExtensionDiagnostic[] = messages.map((message) => ({ level: "warn", message }));
  if (same(byId.get(id), next)) return;
  if (next.length === 0) byId.delete(id);
  else byId.set(id, next);
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error("[extensions] diagnostics listener failed:", err);
    }
  }
}

/** Drop an id's diagnostics (extension gone, or all clear). */
export function clearExtensionDiagnostics(id: string): void {
  setExtensionDiagnostics(id, []);
}

/** Current diagnostics for an id (empty when clean). */
export function getExtensionDiagnostics(id: string): ExtensionDiagnostic[] {
  return byId.get(id) ?? [];
}

/** Every id with at least one diagnostic. */
export function allExtensionDiagnostics(): Map<string, ExtensionDiagnostic[]> {
  return byId;
}

export function subscribeExtensionDiagnostics(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Known slot ids — populated by `src/extensions/slots.tsx` (SLOT_IDS is the
// source of truth; this registry lets the loader validate `requires.slots`
// without importing the component layer).
// ---------------------------------------------------------------------------

const knownSlots = new Set<string>();

export function registerKnownSlots(ids: readonly string[]): void {
  for (const id of ids) knownSlots.add(id);
}

export function isKnownSlot(id: string): boolean {
  return knownSlots.has(id);
}
