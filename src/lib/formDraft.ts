/**
 * Form helpers — R13 "Forms fidelity".
 *
 * Three concerns, one module (kept OUT of the component file so
 * `PendingRequestsPanel.tsx` stays components-only and Fast-Refresh safe):
 *
 *   1. Conditional fields — `when` rules + the static `hidden` flag.
 *      The engine schema (`Form.When` / `Form.StringField.when` …) carries
 *      `when?: Form.When[]` on every non-external field, where
 *      `Form.When = { key, op: "eq" | "neq", value: string | number | boolean }`.
 *      A field is visible iff `hidden !== true` AND every `when` rule matches
 *      (array = AND, matching v2's per-field rule list). Reading rules through
 *      `rulesOf` keeps this forward-compatible with `src/api/types.ts`, which
 *      does not yet declare `when`/`hidden` (see the R13 report).
 *   2. External-link acknowledgement — an `external` field must be
 *      acknowledged before submit. The engine schema has NO acknowledgement
 *      flag (`Form.ExternalField = { key, type:"external", url, title?,
 *      description? }`), so gating is per-external-field and client-side: each
 *      external field blocks submit until its key is in `acked`. If the engine
 *      ever adds an explicit flag, `requiresAck` is the one place to consult it.
 *   3. Drafts across remount — a half-answered form survives unmount/remount.
 *      localStorage-backed, the same one-key-map + cap + shape-guard pattern
 *      as `src/lib/drafts.ts`, keyed logically by form id.
 */

import type { FormField } from "../api/types";

/** `Form.When` — one conditional rule. */
export interface FormWhen {
  key: string;
  op: "eq" | "neq";
  value: string | number | boolean;
}

/** A field's answer value (matches the store's `replyForm` answer shape). */
export type FormValue = string | number | boolean | string[];

/** The full answer map a form collects. */
export type FormValues = Record<string, FormValue>;

/** The rule-bearing overlay the engine sends but `types.ts` does not declare yet. */
export interface FieldRules {
  hidden?: boolean;
  when?: FormWhen[];
}

/** A field's rules, read structurally so this compiles against today's `FormField`. */
export function rulesOf(field: FormField): FieldRules {
  const r = field as FormField & FieldRules;
  return { hidden: r.hidden, when: r.when };
}

/** Human title for a field (falls back to the key, like the panel does). */
export function fieldTitle(field: FormField): string {
  return field.title ?? field.key;
}

/** True when a field is a required answer field (external fields are never "required"). */
export function isRequired(field: FormField): boolean {
  return field.type !== "external" && field.required === true;
}

function looseEqual(a: FormValue | undefined, b: string | number | boolean): boolean {
  if (a === undefined) return false;
  if (typeof a === typeof b) return a === b;
  return String(a) === String(b);
}

/** Evaluate one `when` rule against the current values. */
export function matchWhen(rule: FormWhen, values: FormValues): boolean {
  if (!rule || typeof rule !== "object" || typeof rule.key !== "string") return true;
  const actual = values[rule.key];
  const hit = Array.isArray(actual)
    ? actual.some((v) => looseEqual(v, rule.value))
    : looseEqual(actual, rule.value);
  return rule.op === "eq" ? hit : !hit;
}

/**
 * A field is visible when it is not statically hidden and every `when` rule
 * matches. No rules → visible (the common case).
 */
export function isFieldVisible(field: FormField, values: FormValues): boolean {
  const { hidden, when } = rulesOf(field);
  if (hidden === true) return false;
  if (!when || when.length === 0) return true;
  return when.every((rule) => matchWhen(rule, values));
}

/** The currently visible fields, in declaration order. */
export function visibleFields(fields: readonly FormField[], values: FormValues): FormField[] {
  return fields.filter((f) => isFieldVisible(f, values));
}

/**
 * Whether a field currently holds an answer. Mirrors the panel's `canSubmit`
 * semantics: booleans are always answered (false is a value), numbers count
 * even at 0, multiselects need at least one pick, strings need non-whitespace.
 */
export function isAnswered(field: FormField, values: FormValues): boolean {
  const v = values[field.key];
  switch (field.type) {
    case "boolean":
      return true;
    case "multiselect":
      return Array.isArray(v) && v.length > 0;
    case "number":
    case "integer":
      return typeof v === "number";
    case "string":
      return typeof v === "string" && v.trim().length > 0;
    default:
      return true;
  }
}

/** Visible + required + unanswered fields (the block-list before submit). */
export function missingRequired(fields: readonly FormField[], values: FormValues): FormField[] {
  return visibleFields(fields, values).filter((f) => isRequired(f) && !isAnswered(f, values));
}

/** Readable summary for a field's current value (empty string when unanswered). */
export function formatValue(field: FormField, value: FormValue | undefined): string {
  if (value === undefined || value === null) return "";
  switch (field.type) {
    case "multiselect":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "boolean":
      return value ? "yes" : "no";
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/**
 * The wire answer for a submit: every visible, non-external field's current
 * value (defaults included, same as the panel submitted before this change).
 * Hidden fields are omitted so a `when`-suppressed answer never travels.
 */
export function buildAnswer(fields: readonly FormField[], values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of visibleFields(fields, values)) {
    if (f.type === "external") continue;
    const v = values[f.key];
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

// ---- external-link acknowledgement --------------------------------------

/** Every external-link field on the form (visible or not — links are static). */
export function externalFields(fields: readonly FormField[]): FormField[] {
  return fields.filter((f) => f.type === "external");
}

/**
 * External fields still awaiting acknowledgement. The engine sends no ack
 * flag (finding), so EVERY external field must be acknowledged: an external
 * link is an instruction the model needs the user to have seen.
 */
export function unacknowledgedExternal(
  fields: readonly FormField[],
  acked: readonly string[] = [],
): FormField[] {
  const set = new Set(acked);
  return externalFields(fields).filter((f) => !set.has(f.key));
}

/** True when no external field is outstanding. Vacuously true with no externals. */
export function externalAckSatisfied(
  fields: readonly FormField[],
  acked: readonly string[] = [],
): boolean {
  return unacknowledgedExternal(fields, acked).length === 0;
}

/** Why submit is blocked, in legible words — null when the form is ready. */
export function submitBlocker(
  fields: readonly FormField[],
  values: FormValues,
  acked: readonly string[] = [],
): string | null {
  const missing = missingRequired(fields, values);
  if (missing.length > 0) {
    return `Missing required: ${missing.map(fieldTitle).join(", ")}`;
  }
  const unacked = unacknowledgedExternal(fields, acked);
  if (unacked.length > 0) {
    return `Acknowledge external link${unacked.length > 1 ? "s" : ""}: ${unacked
      .map(fieldTitle)
      .join(", ")}`;
  }
  return null;
}

/** Required satisfied AND every external link acknowledged. */
export function formReady(
  fields: readonly FormField[],
  values: FormValues,
  acked: readonly string[] = [],
): boolean {
  return submitBlocker(fields, values, acked) === null;
}

// ---- review summary ------------------------------------------------------

export interface ReviewRow {
  key: string;
  title: string;
  type: FormField["type"];
  required: boolean;
  answered: boolean;
  /** Readable value, or "" when unanswered. */
  summary: string;
}

export interface ReviewCounts {
  total: number;
  answered: number;
  missing: number;
  /** Missing answers that are also required (the submit blockers). */
  requiredMissing: number;
}

/** One row per visible answer field — the answered/missing/required summary. */
export function reviewRows(fields: readonly FormField[], values: FormValues): ReviewRow[] {
  return visibleFields(fields, values)
    .filter((f) => f.type !== "external")
    .map((f) => {
      const answered = isAnswered(f, values);
      return {
        key: f.key,
        title: fieldTitle(f),
        type: f.type,
        required: isRequired(f),
        answered,
        summary: answered ? formatValue(f, values[f.key]) : "",
      };
    });
}

export function reviewCounts(rows: readonly ReviewRow[]): ReviewCounts {
  let answered = 0;
  let requiredMissing = 0;
  for (const r of rows) {
    if (r.answered) answered++;
    else if (r.required) requiredMissing++;
  }
  return {
    total: rows.length,
    answered,
    missing: rows.length - answered,
    requiredMissing,
  };
}

// ---- drafts across remount ----------------------------------------------

const DRAFTS_KEY = "webui.formDrafts";
/** Cap the map so abandoned forms cannot grow storage without bound. */
const MAX_FORM_DRAFTS = 20;

interface DraftEntry {
  values: FormValues;
  at: number;
}

type DraftMap = Record<string, DraftEntry>;

function isFormValues(value: unknown): value is FormValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) =>
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      (Array.isArray(v) && v.every((x) => typeof x === "string")),
  );
}

function readDrafts(): DraftMap {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DraftMap = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const e = entry as Record<string, unknown>;
      if (e && typeof e === "object" && typeof e.at === "number" && isFormValues(e.values)) {
        out[id] = { values: e.values, at: e.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeDrafts(map: DraftMap): void {
  try {
    if (typeof localStorage === "undefined") return;
    const kept = Object.entries(map)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_FORM_DRAFTS);
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable (private mode/quota) — drafts just don't persist */
  }
}

/** Stored answers for this form, or null when there is no usable draft. */
export function loadFormDraft(formID: string): FormValues | null {
  return readDrafts()[formID]?.values ?? null;
}

/** Persist the current answers for this form (write-through, capped). */
export function saveFormDraft(formID: string, values: FormValues): void {
  const map = readDrafts();
  map[formID] = { values, at: Date.now() };
  writeDrafts(map);
}

/** Drop this form's draft (call after submit/cancel). */
export function clearFormDraft(formID: string): void {
  const map = readDrafts();
  if (!(formID in map)) return;
  delete map[formID];
  writeDrafts(map);
}

/** The localStorage envelope key — exported for tests/inspection only. */
export function formDraftStorageKey(): string {
  return DRAFTS_KEY;
}
