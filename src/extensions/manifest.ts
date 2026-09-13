/**
 * Manifest contract — declared settings + requirements (roadmap items 5 & 8).
 *
 * `manifest.json` may declare a small, checkable schema and a set of
 * references it depends on:
 *
 *   {
 *     "id": "my-extension",
 *     "settings": [
 *       { "key": "enabled", "type": "boolean", "title": "Enabled", "default": true },
 *       { "key": "threshold", "type": "number", "title": "Threshold",
 *         "default": 5, "min": 1, "max": 20 },
 *       { "key": "mode", "type": "enum", "title": "Mode",
 *         "options": ["fast", "thorough"], "default": "fast" }
 *     ],
 *     "requires": {
 *       "api": 1,
 *       "targets": ["message.timestamp"],
 *       "slots": ["composer.above"],
 *       "services": ["format.timestamp"]
 *     },
 *     "capabilities": ["notify"]
 *   }
 *
 * This module is pure (browser-safe, no imports): parse/validate the declared
 * contract, resolve stored values against it, and check `requires` against the
 * live registry. Core renders the schema in Settings › Extensions and reports
 * unmet references instead of a silently blank spot.
 *
 * `settings` schema subset: boolean | number | string | enum, plus
 * min/max/step for numbers and options for enums. Anything else is dropped
 * with a problem message — never a silent no-op.
 */

export type SettingType = "boolean" | "number" | "string" | "enum";

export interface SettingField {
  key: string;
  type: SettingType;
  title: string;
  description?: string;
  default?: unknown;
  /** number only */
  min?: number;
  max?: number;
  step?: number;
  /** enum only */
  options?: string[];
  /** string only */
  placeholder?: string;
}

/** References the extension depends on; core checks each and warns on a miss. */
export interface ExtensionRequires {
  /** Minimum `EXT_API_VERSION` this extension was written against. */
  api?: number;
  /** Registered target ids (registry). */
  targets?: string[];
  /** Known slot ids (`SLOT_IDS`). */
  slots?: string[];
  /** Service ids with a provider (`getService`). */
  services?: string[];
}

export interface ParsedManifestContract {
  settings?: SettingField[];
  requires?: ExtensionRequires;
  /** Human-readable shape problems — surfaced in Settings › Extensions. */
  problems: string[];
}

const SETTING_TYPES: readonly SettingType[] = ["boolean", "number", "string", "enum"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length === v.length ? out : out.length > 0 ? out : undefined;
}

function parseField(raw: unknown, problems: string[]): SettingField | undefined {
  if (!isRecord(raw)) {
    problems.push("settings: every entry must be an object");
    return undefined;
  }
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  if (!key) {
    problems.push("settings: an entry is missing a string `key`");
    return undefined;
  }
  if (typeof raw.type !== "string" || !SETTING_TYPES.includes(raw.type as SettingType)) {
    problems.push(`settings.${key}: type must be one of ${SETTING_TYPES.join(", ")}`);
    return undefined;
  }
  const type = raw.type as SettingType;
  const field: SettingField = {
    key,
    type,
    title: typeof raw.title === "string" && raw.title ? raw.title : key,
  };
  if (typeof raw.description === "string") field.description = raw.description;
  if (type === "number") {
    if (typeof raw.min === "number") field.min = raw.min;
    if (typeof raw.max === "number") field.max = raw.max;
    if (typeof raw.step === "number") field.step = raw.step;
  }
  if (type === "string" && typeof raw.placeholder === "string") field.placeholder = raw.placeholder;
  if (type === "enum") {
    const options = stringArray(raw.options);
    if (!options || options.length === 0) {
      problems.push(`settings.${key}: enum needs a non-empty string[] \`options\``);
      return undefined;
    }
    field.options = options;
  }
  if (raw.default !== undefined) {
    const d = coerce(field, raw.default);
    if (d === undefined) problems.push(`settings.${key}: \`default\` does not match type ${type}`);
    else field.default = d;
  }
  return field;
}

/** Coerce a stored/default value to the field's type. Returns undefined if invalid. */
export function coerce(field: SettingField, value: unknown): unknown {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "string":
      return typeof value === "string" ? value : undefined;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      let n = value;
      if (field.min !== undefined) n = Math.max(field.min, n);
      if (field.max !== undefined) n = Math.min(field.max, n);
      return n;
    }
    case "enum":
      return typeof value === "string" && field.options?.includes(value) ? value : undefined;
  }
}

/** Parse `manifest.json` `settings` + `requires`; collect shape problems. */
export function parseManifestContract(settings: unknown, requires: unknown): ParsedManifestContract {
  const problems: string[] = [];
  let parsedSettings: SettingField[] | undefined;
  if (settings !== undefined) {
    if (!Array.isArray(settings)) {
      problems.push("`settings` must be an array");
    } else {
      const seen = new Set<string>();
      const fields: SettingField[] = [];
      for (const raw of settings) {
        const field = parseField(raw, problems);
        if (!field) continue;
        if (seen.has(field.key)) {
          problems.push(`settings: duplicate key "${field.key}"`);
          continue;
        }
        seen.add(field.key);
        fields.push(field);
      }
      if (fields.length > 0) parsedSettings = fields;
    }
  }

  let parsedRequires: ExtensionRequires | undefined;
  if (requires !== undefined) {
    if (!isRecord(requires)) {
      problems.push("`requires` must be an object");
    } else {
      const r: ExtensionRequires = {};
      if (requires.api !== undefined) {
        if (typeof requires.api === "number" && Number.isFinite(requires.api)) r.api = requires.api;
        else problems.push("requires.api must be a number");
      }
      for (const key of ["targets", "slots", "services"] as const) {
        if (requires[key] === undefined) continue;
        const arr = stringArray(requires[key]);
        if (arr) r[key] = arr;
        else problems.push(`requires.${key} must be a string[]`);
      }
      if (r.api !== undefined || r.targets || r.slots || r.services) parsedRequires = r;
    }
  }

  return { settings: parsedSettings, requires: parsedRequires, problems };
}

/**
 * Resolve effective settings: schema defaults overlaid with stored values that
 * are valid for their field. Unknown/legacy stored keys are dropped (migrated
 * away) — the schema is the contract.
 */
export function resolveSettings(
  schema: SettingField[] | undefined,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return { ...(stored ?? {}) };
  const out: Record<string, unknown> = {};
  for (const field of schema) {
    if (field.default !== undefined) out[field.key] = field.default;
    const value = stored?.[field.key];
    if (value === undefined) continue;
    const coerced = coerce(field, value);
    if (coerced !== undefined) out[field.key] = coerced;
  }
  return out;
}

/** The registry facts `requires` is checked against. */
export interface RequiresEnv {
  apiVersion: number;
  hasTarget: (id: string) => boolean;
  hasSlot: (id: string) => boolean;
  hasService: (id: string) => boolean;
}

/** Unmet requirement messages (empty = satisfied). */
export function checkRequires(
  requires: ExtensionRequires | undefined,
  env: RequiresEnv,
): string[] {
  if (!requires) return [];
  const unmet: string[] = [];
  if (requires.api !== undefined && requires.api > env.apiVersion) {
    unmet.push(`needs extension API v${requires.api} (this build is v${env.apiVersion})`);
  }
  for (const t of requires.targets ?? []) {
    if (!env.hasTarget(t)) unmet.push(`unmet target "${t}"`);
  }
  for (const s of requires.slots ?? []) {
    if (!env.hasSlot(s)) unmet.push(`unmet slot "${s}"`);
  }
  for (const svc of requires.services ?? []) {
    if (!env.hasService(svc)) unmet.push(`unmet service "${svc}"`);
  }
  return unmet;
}
