/**
 * Per-extension settings (roadmap item 5).
 *
 * The manifest declares the schema (`src/extensions/manifest.ts`); core stores
 * the values per extension id via the existing `extKv` and resolves them
 * against the schema (defaults applied, invalid/legacy values dropped). The
 * extension reads resolved values through `ctx.settings` (activate) or the
 * bridge's `settings.forExt(id)` — it never rolls its own storage or UI.
 *
 * The schema registry is populated by the loaders from the manifest before an
 * extension activates, so `extensionSettings(id)` is always schema-aware.
 */

import { extKv } from "./extKv";
import { coerce, resolveSettings, type SettingField } from "../extensions/manifest";

const STORAGE_KEY = "settings";

const schemas = new Map<string, SettingField[]>();
const listeners = new Map<string, Set<() => void>>();

/** Loader hook: the declared schema for an extension id (undefined clears it). */
export function registerExtensionSchema(id: string, schema: SettingField[] | undefined): void {
  if (schema && schema.length > 0) schemas.set(id, schema);
  else schemas.delete(id);
}

/** The declared schema for an id (empty array when none). */
export function extensionSchema(id: string): SettingField[] {
  return schemas.get(id) ?? [];
}

function readStored(id: string): Record<string, unknown> {
  const v = extKv(id).get<Record<string, unknown>>(STORAGE_KEY);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** Defaults overlaid with valid stored values (the extension's view). */
export function resolvedExtensionSettings(id: string): Record<string, unknown> {
  return resolveSettings(schemas.get(id), readStored(id));
}

function notify(id: string): void {
  for (const fn of listeners.get(id) ?? []) {
    try {
      fn();
    } catch (err) {
      console.error(`[extensions] settings listener for "${id}" failed:`, err);
    }
  }
}

/** Persist one value (coerced to the field type when a schema declares it). */
export function setExtensionSetting(id: string, key: string, value: unknown): void {
  const field = schemas.get(id)?.find((f) => f.key === key);
  const next = { ...readStored(id) };
  if (field) {
    const coerced = coerce(field, value);
    if (coerced === undefined) return; // invalid for the declared type — ignore
    next[key] = coerced;
  } else {
    next[key] = value;
  }
  extKv(id).set(STORAGE_KEY, next);
  notify(id);
}

/** Drop all stored overrides for an id (defaults take over). */
export function resetExtensionSettings(id: string): void {
  extKv(id).delete(STORAGE_KEY);
  notify(id);
}

export function subscribeExtensionSettings(id: string, fn: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  const owned = set;
  owned.add(fn);
  return () => {
    owned.delete(fn);
    if (owned.size === 0) listeners.delete(id);
  };
}

export interface ExtensionSettingsHandle {
  /** Effective values (defaults + stored). */
  get(): Record<string, unknown>;
  /** The declared schema (empty when the manifest declares none). */
  schema(): SettingField[];
  /** Persist one value. */
  set(key: string, value: unknown): void;
  /** Clear stored overrides. */
  reset(): void;
  /** Change notification (fires after set/reset). */
  subscribe(fn: () => void): () => void;
}

/** The settings handle for one extension id (same object as the bridge). */
export function extensionSettings(id: string): ExtensionSettingsHandle {
  return {
    get: () => resolvedExtensionSettings(id),
    schema: () => extensionSchema(id),
    set: (key, value) => setExtensionSetting(id, key, value),
    reset: () => resetExtensionSettings(id),
    subscribe: (fn) => subscribeExtensionSettings(id, fn),
  };
}
