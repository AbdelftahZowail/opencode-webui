/**
 * The user-facing kill switch for RUNTIME (plugin-shipped) extensions.
 *
 * Defaults to ON: a plugin being installed means the user wanted it. Any id
 * in this list is skipped by the runtime loader (and shown as off in
 * Settings › Extensions). Built-in `ui-extensions/` are NOT gated here —
 * they keep using `config.ts`.
 *
 * Shared by the runtime loader (src/lib/runtimeExtensions.ts) and the
 * Settings › Extensions section.
 */

const KEY = "webui.ext.disabled";

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function read(): string[] {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function isDisabled(id: string): boolean {
  return read().includes(id);
}

export function setDisabled(id: string, disabled: boolean): void {
  const next = new Set(read());
  if (disabled) next.add(id);
  else next.delete(id);
  cache = [...next];
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage full/blocked — session-only fallback */
  }
  for (const listener of listeners) listener();
}

export function subscribeExtGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
