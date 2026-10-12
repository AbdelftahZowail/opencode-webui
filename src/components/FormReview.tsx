import { CheckIcon, XIcon } from "lucide-react";
import type { FormField } from "../api/types";
import { autoRegister } from "../extensions/registry";
import { Button } from "./ui/button";
import {
  externalFields,
  fieldTitle,
  reviewCounts,
  reviewRows,
  submitBlocker,
  type FormValues,
} from "../lib/formDraft";

/**
 * R13 "Forms fidelity" — the form Review tab.
 *
 * A read-only pass over the form's answers before submit: every visible field
 * with an answered / missing annotation, the required markers, and the
 * external-link acknowledgement state. It never submits — the panel owns the
 * submit action — so this is safe to render while the user is still editing.
 *
 * Props are intentionally plain (`fields`, `values`, `acked`, `onClose`) so the
 * call site can render it through `<Target id="form.review" …>` and extensions
 * can wrap/replace it.
 */
export interface FormReviewProps {
  fields: FormField[];
  values: FormValues;
  /** External-field keys the user has acknowledged. */
  acked?: string[];
  /** Close/return handler; the panel keeps the tab state. */
  onClose?: () => void;
}

export function FormReview({ fields, values, acked = [], onClose }: FormReviewProps) {
  const rows = reviewRows(fields, values);
  const counts = reviewCounts(rows);
  const external = externalFields(fields);
  const unacked = external.filter((f) => !acked.includes(f.key));
  const blocker = submitBlocker(fields, values, acked);

  return (
    <div data-oc-form-review className="font-sans text-xs">
      <div className="flex items-baseline justify-between gap-2 pb-1.5">
        <span className="font-medium text-[color:var(--text-strong)]">Review answers</span>
        <span className="text-[color:var(--text-weak)]">
          {counts.answered}/{counts.total} answered
        </span>
      </div>

      {/* Legible blocker — the acceptance criterion "submitting with a required
          field missing is blocked with a legible reason". */}
      <div
        data-oc-form-review-status
        className={`mb-2 rounded-md border px-2.5 py-1.5 ${
          blocker
            ? "border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] text-[color:var(--surface-warning-strong)]"
            : "border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] text-[color:var(--surface-success-strong)]"
        }`}
      >
        {blocker ?? "All required answers present — ready to submit."}
      </div>

      {rows.length === 0 ? (
        <p className="py-1 text-[color:var(--text-weaker)]">No answer fields.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li
              key={row.key}
              data-oc-form-review-row={row.key}
              className="flex items-start gap-2 border-b border-[color:var(--border-weak-base)] pb-1 last:border-b-0"
            >
              {row.answered ? (
                <CheckIcon
                  className="mt-0.5 size-3.5 shrink-0 text-[color:var(--surface-success-strong)]"
                  aria-hidden
                />
              ) : (
                <XIcon
                  className={`mt-0.5 size-3.5 shrink-0 ${
                    row.required
                      ? "text-[color:var(--surface-critical-strong)]"
                      : "text-[color:var(--text-weaker)]"
                  }`}
                  aria-hidden
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1">
                  <span className="font-medium text-[color:var(--text-base)]">{row.title}</span>
                  {row.required && (
                    <span className="text-[color:var(--surface-critical-strong)]">*</span>
                  )}
                </div>
                <div
                  className={
                    row.answered
                      ? "truncate font-mono text-[color:var(--text-weak)]"
                      : "text-[color:var(--text-weaker)]"
                  }
                >
                  {row.answered ? row.summary || "(empty)" : "missing"}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {external.length > 0 && (
        <div className="pt-1.5">
          <p className="pb-0.5 text-[color:var(--text-weak)]">External links</p>
          <ul className="space-y-0.5">
            {external.map((f) => {
              const ok = !unacked.includes(f);
              return (
                <li key={f.key} className="flex items-center gap-2">
                  <span
                    className={
                      ok
                        ? "text-[color:var(--surface-success-strong)]"
                        : "text-[color:var(--surface-warning-strong)]"
                    }
                  >
                    {ok ? "acknowledged" : "not acknowledged"}
                  </span>
                  <span className="truncate text-[color:var(--text-weak)]">{fieldTitle(f)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {counts.requiredMissing > 0 && (
        <p className="pt-1.5 text-[color:var(--surface-critical-strong)]">
          {counts.requiredMissing} required field{counts.requiredMissing > 1 ? "s" : ""} still
          missing.
        </p>
      )}

      {onClose && (
        <div className="flex justify-end pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Back to form
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3) — target "form.review".
// ---------------------------------------------------------------------------

autoRegister({
  "form.review": (p) => <FormReview {...(p as unknown as FormReviewProps)} />,
});
